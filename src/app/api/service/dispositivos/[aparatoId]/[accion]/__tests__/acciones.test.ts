/**
 * Lo que el CRM (u otra aplicación) hace con SUS aparatos por la red interna: bloquear, desbloquear y renombrar. Se ata, sobre todo,
 * que NO pueda tocar uno de otra aplicación (404, no 403: no se cuenta qué aparatos hay), que sin el scope de dispositivos no haga
 * nada, y que haga lo mismo que el panel (cierra la cadena, audita con el servicio que lo pidió, avisa por el canal de su app).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({ dispositivo: { findUnique: vi.fn(), update: vi.fn() } }))
const familias = vi.hoisted(() => ({ cerrarFamilia: vi.fn(), desdeDondePide: vi.fn(() => ({ ip: '10.0.0.5', userAgent: 'crm-api' })) }))
const avisos = vi.hoisted(() => ({ avisarDeDispositivo: vi.fn() }))
const auditoria = vi.hoisted(() => ({ audit: vi.fn() }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/apk-tokens', () => familias)
vi.mock('@/lib/eventos-de-dispositivos', () => avisos)
vi.mock('@/lib/audit', () => auditoria)
vi.mock('@/lib/with-service-auth', () => ({ withServiceAuth: (h: unknown) => h }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../route'

const ID = '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10'
const ctxCon = (...scopes: string[]) => ({ client: { clientId: 'crm', keyVersion: 1, scopes, name: 'CRM' } })
const CRM = ctxCon('dispositivos:crm-apk')
const FILA = { id: 'd1', clientId: 'crm-apk', aparatoId: ID, userId: 'u1', familyId: 'fam1', bloqueadoAt: null as Date | null }

const llamar = (accion: string, cuerpo?: unknown, ctx = CRM, query = '', id = ID) =>
    (POST as unknown as (r: Request, c: unknown) => Promise<Response>)(
        new Request(`http://x/api/service/dispositivos/${id}/${accion}${query}`, { method: 'POST', body: cuerpo === undefined ? undefined : typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo) }),
        ctx,
    )

beforeEach(() => {
    vi.resetAllMocks()
    familias.desdeDondePide.mockReturnValue({ ip: '10.0.0.5', userAgent: 'crm-api' })
    db.dispositivo.findUnique.mockResolvedValue(FILA)
    db.dispositivo.update.mockResolvedValue({})
    familias.cerrarFamilia.mockResolvedValue(undefined)
    avisos.avisarDeDispositivo.mockResolvedValue(true)
})

describe('el alcance: SOLO los aparatos de su aplicación', () => {
    it('la búsqueda lleva la app de la CREDENCIAL: un aparato de otra app no se encuentra (404)', async () => {
        db.dispositivo.findUnique.mockResolvedValue(null)
        expect((await llamar('bloquear')).status).toBe(404)
        expect(db.dispositivo.findUnique.mock.calls[0][0].where).toEqual({ clientId_aparatoId: { clientId: 'crm-apk', aparatoId: ID } })
        expect(db.dispositivo.update).not.toHaveBeenCalled()
        expect(avisos.avisarDeDispositivo).not.toHaveBeenCalled()
    })
    it('sin el scope de dispositivos, o con `?app=` ajeno: 403 y no toca nada', async () => {
        expect((await llamar('bloquear', undefined, ctxCon('callback:create'))).status).toBe(403)
        expect((await llamar('bloquear', undefined, ctxCon('*'))).status).toBe(403)
        const ajena = await llamar('bloquear', undefined, CRM, '?app=reparto')
        expect(ajena.status).toBe(403)
        expect((await ajena.json()).error).toBe('app_no_permitida')
        expect(db.dispositivo.findUnique).not.toHaveBeenCalled()
    })
    it('una acción que no existe, o un id que no es un UUID: 404', async () => {
        expect((await llamar('borrar')).status).toBe(404)
        expect((await llamar('bloquear', undefined, CRM, '', 'no-es-uuid')).status).toBe(404)
        expect(db.dispositivo.findUnique).not.toHaveBeenCalled()
    })
})

describe('las acciones hacen lo mismo que el panel', () => {
    it('bloquear: marca el bloqueo (con el servicio que lo pidió), cierra la cadena, audita y avisa por el canal de su app', async () => {
        const r = await llamar('bloquear')
        expect(await r.json()).toEqual({ ok: true, estado: 'bloqueado' })
        expect(db.dispositivo.update.mock.calls[0][0].data).toMatchObject({ bloqueadoPor: 'crm' })
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam1')
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({
            action: 'dispositivo.bloquear', clientId: 'crm-apk', resource: ID, userId: undefined,
            meta: expect.objectContaining({ via: 'servicio', servicio: 'crm' }),
        }))
        const [d, motivo] = avisos.avisarDeDispositivo.mock.calls[0]
        expect(d).toMatchObject({ clientId: 'crm-apk', aparatoId: ID })
        expect(d.bloqueadoAt).toBeInstanceOf(Date)
        expect(motivo).toBe('bloqueado')
    })

    it('desbloquear: lo deja activo y avisa con motivo `desbloqueado`', async () => {
        db.dispositivo.findUnique.mockResolvedValue({ ...FILA, bloqueadoAt: new Date() })
        expect(await (await llamar('desbloquear')).json()).toEqual({ ok: true, estado: 'activo' })
        expect(db.dispositivo.update.mock.calls[0][0].data).toEqual({ bloqueadoAt: null, bloqueadoPor: null })
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.objectContaining({ bloqueadoAt: null }), 'desbloqueado')
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
    })

    it('nombre: se limpia, vacío o null lo quita, y avisa `renombrado`; no cambia el estado de bloqueo', async () => {
        const r = await llamar('nombre', { nombre: '  Samsung   de\nPalma ' })
        expect(await r.json()).toEqual({ ok: true, estado: 'activo' })
        expect(db.dispositivo.update.mock.calls[0][0].data).toEqual({ nombre: 'Samsung de Palma' })
        await llamar('nombre', { nombre: null })
        expect(db.dispositivo.update.mock.calls[1][0].data).toEqual({ nombre: null })
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.anything(), 'renombrado')
    })

    it('un cuerpo malo en `nombre` es 400; si el AVISO falla, la acción ya está hecha (200)', async () => {
        expect((await llamar('nombre', 'no es json')).status).toBe(400)
        expect((await llamar('nombre', { nombre: 5 })).status).toBe(400)
        avisos.avisarDeDispositivo.mockResolvedValue(false)
        expect((await llamar('bloquear')).status).toBe(200)
        expect(db.dispositivo.update).toHaveBeenCalled()
    })
})
