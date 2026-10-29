/**
 * Lo que un administrador hace con un aparato: nombre, cerrar sesión, bloquear, desbloquear. Se ata que SOLO el administrador global
 * puede, que cada acción AVISA a la aplicación dueña (y que un fallo del aviso no deshace la acción), que bloquear cierra la cadena
 * de refresh del aparato, que queda en la auditoría, y que lo ajeno (otro sitio, JSON malo, id raro) se rechaza.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

process.env.APP_URL = 'https://auth.example.com'

const db = vi.hoisted(() => ({ dispositivo: { findUnique: vi.fn(), update: vi.fn() } }))
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

const FILA = {
    id: 'd1', clientId: 'crm-apk', aparatoId: '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10', userId: 'u1', familyId: 'fam1', bloqueadoAt: null, nombre: null,
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
    db.dispositivo.findUnique.mockResolvedValue(FILA)
    db.dispositivo.update.mockResolvedValue({})
    familias.cerrarFamilia.mockResolvedValue(undefined)
    avisos.avisarDeDispositivo.mockResolvedValue(true)
})

describe('quién puede', () => {
    it('quien no es administrador global NO toca nada (401/403 tal cual)', async () => {
        admin.requireSystemAdmin.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }))
        expect((await llamar({ accion: 'bloquear' })).status).toBe(403)
        expect(db.dispositivo.update).not.toHaveBeenCalled()
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
        db.dispositivo.findUnique.mockResolvedValue(null)
        expect((await llamar({ accion: 'bloquear' })).status).toBe(404)
    })
})

describe('las acciones', () => {
    it('bloquear: marca el bloqueo con quién, cierra la cadena de refresh, AUDITA y avisa a la aplicación dueña', async () => {
        expect((await llamar({ accion: 'bloquear' })).status).toBe(200)
        expect(db.dispositivo.update.mock.calls[0][0].data).toMatchObject({ bloqueadoPor: 'admin1' })
        expect(db.dispositivo.update.mock.calls[0][0].data.bloqueadoAt).toBeInstanceOf(Date)
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam1')
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'dispositivo.bloquear', userId: 'admin1', resource: FILA.aparatoId }))
        const [d, motivo] = avisos.avisarDeDispositivo.mock.calls[0]
        expect(d).toMatchObject({ clientId: 'crm-apk', aparatoId: FILA.aparatoId })
        expect(d.bloqueadoAt).toBeInstanceOf(Date)
        expect(motivo).toBe('bloqueado')
    })

    it('desbloquear: quita el bloqueo y avisa con el aparato ya activo', async () => {
        db.dispositivo.findUnique.mockResolvedValue({ ...FILA, bloqueadoAt: new Date() })
        await llamar({ accion: 'desbloquear' })
        expect(db.dispositivo.update.mock.calls[0][0].data).toEqual({ bloqueadoAt: null, bloqueadoPor: null })
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.objectContaining({ bloqueadoAt: null }), 'desbloqueado')
        expect(familias.cerrarFamilia).not.toHaveBeenCalled()
    })

    it('cerrar sesión: cierra la cadena SIN bloquear; sin cadena es 409, no se inventa', async () => {
        expect((await llamar({ accion: 'cerrar' })).status).toBe(200)
        expect(familias.cerrarFamilia).toHaveBeenCalledWith('fam1')
        expect(db.dispositivo.update).not.toHaveBeenCalled()
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.objectContaining({ bloqueadoAt: null }), 'sesion-cerrada')

        vi.clearAllMocks()
        admin.requireSystemAdmin.mockResolvedValue({ user: { id: 'admin1' }, session: {} })
        db.dispositivo.findUnique.mockResolvedValue({ ...FILA, familyId: null })
        expect((await llamar({ accion: 'cerrar' })).status).toBe(409)
        expect(avisos.avisarDeDispositivo).not.toHaveBeenCalled()
    })

    it('nombre: se limpia, vacío = quitarlo, y avisa (la aplicación muestra el nombre)', async () => {
        await llamar({ accion: 'nombre', nombre: '  Samsung   de\nPalma ' })
        expect(db.dispositivo.update.mock.calls[0][0].data).toEqual({ nombre: 'Samsung de Palma' })
        await llamar({ accion: 'nombre', nombre: '   ' })
        expect(db.dispositivo.update.mock.calls[1][0].data).toEqual({ nombre: null })
        expect(avisos.avisarDeDispositivo).toHaveBeenCalledWith(expect.anything(), 'renombrado')
    })

    it('si el AVISO falla, la acción ya está hecha y la respuesta es 200', async () => {
        avisos.avisarDeDispositivo.mockResolvedValue(false)
        expect((await llamar({ accion: 'bloquear' })).status).toBe(200)
        expect(db.dispositivo.update).toHaveBeenCalled()
    })
})
