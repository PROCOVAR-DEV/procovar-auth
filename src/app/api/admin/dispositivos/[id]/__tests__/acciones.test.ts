/**
 * Lo que un administrador hace con un aparato: nombre, cerrar sesión, bloquear, desbloquear. Se ata que SOLO el administrador global
 * puede, que cada acción AVISA a la aplicación dueña (y que un fallo del aviso no deshace la acción), que bloquear cierra la cadena
 * de refresh del aparato, que queda en la auditoría, y que lo ajeno (otro sitio, JSON malo, id raro) se rechaza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

process.env.APP_URL = 'https://auth.example.com'

const db = vi.hoisted(() => ({
    dispositivo: { update: vi.fn(), create: vi.fn(), findUnique: vi.fn(), deleteMany: vi.fn() },
    dispositivoApp: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
}))
const admin = vi.hoisted(() => ({ requireSystemAdmin: vi.fn() }))
const familias = vi.hoisted(() => ({ cerrarFamilia: vi.fn(), desdeDondePide: vi.fn(() => ({ ip: '1.2.3.4', userAgent: 'Mozilla' })) }))
const avisos = vi.hoisted(() => ({ avisarDeDispositivo: vi.fn() }))
const auditoria = vi.hoisted(() => ({ audit: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/require-admin', () => admin)
vi.mock('@/lib/apk-tokens', () => familias)
vi.mock('@/lib/eventos-de-dispositivos', () => avisos)
vi.mock('@/lib/audit', () => auditoria)
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { POST } from '../route'

const APARATO = '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10'
/** La fila del aparato EN SU APLICACIÓN (`dispositivo_app`), con el aparato dentro. */
const FILA = {
    id: 'd1', dispositivoId: 'dis1', clientId: 'crm-apk', aparatoId: APARATO, userId: 'u1', familyId: 'fam1', bloqueadoAt: null,
}

function llamar(cuerpo: unknown, opciones: { origen?: string; tipo?: string; id?: string } = {}) {
    const req = {
        headers: new Headers({
            'content-type': opciones.tipo ?? 'application/json',
            ...(opciones.origen ? { origin: opciones.origen } : {}),
        }),
        json: async () => { if (cuerpo === 'MALO') throw new Error('json'); return cuerpo },
    } as never
    return (POST as unknown as (r: never, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: opciones.id ?? 'd1' }) })
}

beforeEach(() => {
    vi.resetAllMocks()
    familias.desdeDondePide.mockReturnValue({ ip: '1.2.3.4', userAgent: 'Mozilla' })
    admin.requireSystemAdmin.mockResolvedValue({ user: { id: 'admin1' }, session: {} })
    db.dispositivoApp.findUnique.mockResolvedValue(FILA)
    db.dispositivo.update.mockResolvedValue({})
    db.dispositivoApp.update.mockResolvedValue({})
    db.dispositivoApp.updateMany.mockResolvedValue({ count: 2 })
    db.dispositivoApp.findMany.mockResolvedValue([{ clientId: 'crm-apk', bloqueadoAt: null }, { clientId: 'delivery-apk', bloqueadoAt: null }])
    familias.cerrarFamilia.mockResolvedValue(undefined)
    avisos.avisarDeDispositivo.mockResolvedValue(true)
})

describe('quién puede', () => {
    it('quien no es administrador global NO toca nada (401/403 tal cual)', async () => {
        admin.requireSystemAdmin.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }))
        expect((await llamar({ accion: 'bloquear' })).status).toBe(403)
        expect(db.dispositivoApp.update).not.toHaveBeenCalled()
        expect(avisos.avisarDeDispositivo).not.toHaveBeenCalled()
    })
    it('un POST de otro sitio es 403 y uno que no es JSON, 415 (antes de mirar quién es)', async () => {
        expect((await llamar({ accion: 'bloquear' }, { origen: 'https://malo.example' })).status).toBe(403)
        expect((await llamar({ accion: 'bloquear' }, { tipo: 'text/plain' })).status).toBe(415)
        expect(admin.requireSystemAdmin).not.toHaveBeenCalled()
    })
    it('JSON malo, acción inventada, id raro o fila que no existe', async () => {
        expect((await llamar('MALO')).status).toBe(400)
        expect((await llamar({ accion: 'borrar-todo' })).status).toBe(400)
        expect((await llamar({ accion: 'bloquear' }, { id: '../x' })).status).toBe(404)
        db.dispositivoApp.findUnique.mockResolvedValue(null)
        expect((await llamar({ accion: 'bloquear' })).status).toBe(404)
    })
})

describe('las acciones', () => {
    it('bloquear: marca el bloqueo con quién, cierra la cadena de refresh, AUDITA y avisa a la aplicación dueña', async () => {
        expect((await llamar({ accion: 'bloquear' })).status).toBe(200)
        expect(db.dispositivoApp.update.mock.calls[0][0].where).toEqual({ id: 'd1' })
        expect(db.dispositivoApp.update.mock.calls[0][0].data).toMatchObject({ bloqueadoPor: 'admin1' })
        expect(db.dispositivoApp.update.mock.calls[0][0].data.bloqueadoAt).toBeInstanceOf(Date)
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam1')
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispositivo.bloquear', userId: 'admin1', resource: APARATO }))
        const [d, motivo] = avisos.avisarDeDispositivo.mock.calls[0]
        expect(d).toMatchObject({ clientId: 'crm-apk', aparatoId: APARATO })
        expect(d.bloqueadoAt).toBeInstanceOf(Date)
        expect(motivo).toBe('bloqueado')
    })

    it('desbloquear: quita el bloqueo y avisa con el aparato ya activo', async () => {
        db.dispositivoApp.findUnique.mockResolvedValue({ ...FILA, bloqueadoAt: new Date() })
        await llamar({ accion: 'desbloquear' })
        expect(db.dispositivoApp.update.mock.calls[0][0].data).toEqual({ bloqueadoAt: null, bloqueadoPor: null })
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.objectContaining({ bloqueadoAt: null }), 'desbloqueado')
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
    })

    it('cerrar sesión: cierra la cadena SIN bloquear; sin cadena es 409, no se inventa', async () => {
        expect((await llamar({ accion: 'cerrar' })).status).toBe(200)
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam1')
        expect(db.dispositivoApp.update).not.toHaveBeenCalled()
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.objectContaining({ bloqueadoAt: null }), 'sesion-cerrada')

        vi.clearAllMocks()
        admin.requireSystemAdmin.mockResolvedValue({ user: { id: 'admin1' }, session: {} })
        db.dispositivoApp.findUnique.mockResolvedValue({ ...FILA, familyId: null })
        expect((await llamar({ accion: 'cerrar' })).status).toBe(409)
        expect(avisos.avisarDeDispositivo).not.toHaveBeenCalled()
    })

    it('nombre: es del APARATO (se pisa en `dispositivo`, no en una aplicación), se limpia, vacío = quitarlo, y AVISA a cada aplicación donde está', async () => {
        await llamar({ accion: 'nombre', nombre: '  Samsung   de\nPalma ' })
        expect(db.dispositivo.update.mock.calls[0][0]).toEqual({ where: { id: 'dis1' }, data: { nombre: 'Samsung de Palma' } })
        await llamar({ accion: 'nombre', nombre: '   ' })
        expect(db.dispositivo.update.mock.calls[1][0].data).toEqual({ nombre: null })
        // sube el `updatedAt` de TODAS sus aplicaciones para que su lista con `desde=` lo recoja…
        expect(db.dispositivoApp.updateMany.mock.calls[0][0].where).toEqual({ dispositivoId: 'dis1' })
        // …y las avisa a las dos por su canal, no solo a la que lo pidió
        const avisadas = avisos.avisarDeDispositivo.mock.calls.slice(0, 2).map((c) => c[0].clientId)
        expect(avisadas).toEqual(['crm-apk', 'delivery-apk'])
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.anything(), 'renombrado')
    })

    it('bloquear es POR APLICACIÓN: solo se toca la fila de esa aplicación y solo se avisa a la suya', async () => {
        await llamar({ accion: 'bloquear' })
        expect(db.dispositivoApp.update).toHaveBeenCalledTimes(1)
        expect(db.dispositivoApp.updateMany).not.toHaveBeenCalled()
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledTimes(1)
        expect(avisos.avisarDeDispositivo.mock.calls[0][0].clientId).toBe('crm-apk')
    })

    it('si el AVISO falla, la acción ya está hecha y la respuesta es 200', async () => {
        avisos.avisarDeDispositivo.mockResolvedValue(false)
        expect((await llamar({ accion: 'bloquear' })).status).toBe(200)
        expect(db.dispositivoApp.update).toHaveBeenCalled()
    })
})

describe('agrupar instalaciones: Unir y Separar (solo el panel)', () => {
    it('unir: mueve la instalación al aparato de la otra, borra el que se queda vacío y AUDITA; no avisa a nadie', async () => {
        db.dispositivoApp.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
            where.id === 'd1' ? FILA : { id: 'otra', dispositivoId: 'dis2' })
        db.dispositivo.deleteMany.mockResolvedValue({ count: 1 })
        expect((await llamar({ accion: 'unir', con: 'otra' })).status).toBe(200)
        expect(db.dispositivoApp.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { dispositivoId: 'dis2' } })
        expect(db.dispositivo.deleteMany).toHaveBeenCalledWith({ where: { id: 'dis1', apps: { none: {} } } })
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispositivo.unir', userId: 'admin1' }))
        expect(avisos.avisarDeDispositivo).not.toHaveBeenCalled()
    })

    it('unir con una instalación del MISMO aparato es 409; con una que no existe, 404', async () => {
        db.dispositivoApp.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
            where.id === 'd1' ? FILA : where.id === 'misma' ? { id: 'misma', dispositivoId: 'dis1' } : null)
        expect((await llamar({ accion: 'unir', con: 'misma' })).status).toBe(409)
        expect((await llamar({ accion: 'unir', con: 'fantasma' })).status).toBe(404)
        expect(db.dispositivoApp.update).not.toHaveBeenCalled()
    })

    it('separar: da un aparato propio (SIN la huella) a la instalación; si ya está sola, 409', async () => {
        db.dispositivoApp.count.mockResolvedValue(2)
        db.dispositivo.findUnique.mockResolvedValue({ equipo: 'Samsung A14', plataforma: 'Android' })
        db.dispositivo.create.mockResolvedValue({ id: 'nuevo' })
        db.dispositivo.deleteMany.mockResolvedValue({ count: 0 })
        expect((await llamar({ accion: 'separar' })).status).toBe(200)
        expect(db.dispositivo.create.mock.calls[0][0].data).not.toHaveProperty('huella')
        expect(db.dispositivoApp.update).toHaveBeenCalledWith({ where: { id: 'd1' }, data: { dispositivoId: 'nuevo' } })
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispositivo.separar' }))

        db.dispositivoApp.count.mockResolvedValue(1)
        expect((await llamar({ accion: 'separar' })).status).toBe(409)
    })
})
