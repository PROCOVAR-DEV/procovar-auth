/**
 * Cambiar o restablecer la contraseña cierra TAMBIÉN los refresh de la APK y del escritorio.
 *
 * `revokeSessions…` de better-auth sólo borra SUS sesiones y `renovar` no las mira: un refresh robado
 * seguía valiendo 30 días después del cambio. Aquí, better-auth DE VERDAD (adaptador en memoria) con los
 * hooks REALES de `lib/auth.ts`, la tabla `refresh_token` en memoria y `renovar` real de `apk-tokens.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'

// scrypt de better-auth + varios ficheros en paralelo: el límite por defecto (5 s) se queda corto en máquinas cargadas
vi.setConfig({ testTimeout: 30_000 })

process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
process.env.APP_URL = 'https://auth.example.com'

type Fila = Record<string, unknown>
const tabla = vi.hoisted(() => ({ refresh: [] as Fila[], sesiones: [] as Fila[] }))
/** `where` de Prisma reducido a lo que se usa aquí: igualdad e `in`. */
const cumple = (f: Fila, w: Fila) =>
    Object.entries(w).every(([k, v]) => (v && typeof v === 'object' && 'in' in v ? (v as { in: unknown[] }).in.includes(f[k]) : f[k] === v))
const prismaFalso = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: {
        findUnique: vi.fn(async ({ where }: { where: Fila }) => tabla.refresh.find((f) => cumple(f, where)) ?? null),
        findMany: vi.fn(async ({ where }: { where: Fila }) => tabla.refresh.filter((f) => cumple(f, where)).map((f) => ({ sessionId: f.sessionId }))),
        findFirst: vi.fn(async ({ where }: { where: Fila }) => tabla.refresh.find((f) => cumple(f, where)) ?? null),
        updateMany: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
            const filas = tabla.refresh.filter((f) => cumple(f, where))
            filas.forEach((f) => Object.assign(f, data))
            return { count: filas.length }
        }),
        update: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => Object.assign(tabla.refresh.find((f) => cumple(f, where))!, data)),
        create: vi.fn(async ({ data }: { data: Fila }) => {
            const f = { id: `nuevo${tabla.refresh.length}`, usedAt: null, revokedAt: null, graceUsedAt: null, ...data }
            tabla.refresh.push(f)
            return f
        }),
    },
    session: {
        findUnique: vi.fn(async () => ({ revokedAt: null })),
        updateMany: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
            const filas = tabla.sesiones.filter((f) => cumple(f, where))
            filas.forEach((f) => Object.assign(f, data))
            return { count: filas.length }
        }),
    },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaFalso }))
vi.mock('@/lib/eventos-de-sesion', () => ({ publicarSesionCerrada: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/historial-de-inicios', () => ({ auditarInicioWeb: vi.fn(async () => {}) }))

import { cerrarTodasLasFamiliasDe, renovar, SEGUNDOS_REFRESH } from '@/lib/apk-tokens'
import { publicarSesionCerrada } from '@/lib/eventos-de-sesion'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const persona = (id: string) => ({
    id, name: id, email: `${id}@procovar.local`, username: id, activo: true, isSystemAdmin: false,
    defaultRole: { name: 'OPERADOR', permissions: [{ permission: { key: 'delivery.entrar' } }] },
    members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [{ role: { name: 'OPERADOR' } }] }],
})
/** Un refresh vivo de una persona, con su sesión de aparato ligada. */
function conRefresh(userId: string, raw: string, sessionId: string) {
    tabla.refresh.push({
        id: `rt-${raw}`, userId, sessionId, familyId: `fam-${raw}`, clientId: 'delivery-apk', tokenHash: sha(raw),
        expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000), usedAt: null, revokedAt: null, graceUsedAt: null,
    })
    tabla.sesiones.push({ id: sessionId, userId, revokedAt: null })
}

async function mundo() {
    const { auth: real } = await import('@/lib/auth')
    const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
    const auth = betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true, revokeSessionsOnPasswordReset: true },
        session: real.options.session,
        hooks: real.options.hooks,
    })
    const alta = async (nombre: string) => {
        const r = await auth.api.signUpEmail({ body: { email: `${nombre}@procovar.local`, password: 'una-clave-larga-123', name: nombre }, returnHeaders: true })
        return { id: r.response.user.id, cookie: (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ') }
    }
    return { auth, db, alta }
}

beforeEach(() => {
    vi.clearAllMocks()
    tabla.refresh.length = 0
    tabla.sesiones.length = 0
    prismaFalso.user.findUnique.mockImplementation((async ({ where }: { where: { id: string } }) => persona(where.id)) as never)
})

describe('cerrarTodasLasFamiliasDe', () => {
    it('revoca todos los refresh vivos de ESA persona y sus sesiones ligadas; los de otra, intactos', async () => {
        conRefresh('ana', 'ana-1', 'sa1')
        conRefresh('ana', 'ana-2', 'sa2')
        conRefresh('beto', 'beto-1', 'sb1')
        expect(await cerrarTodasLasFamiliasDe('ana')).toBe(2)
        expect(tabla.refresh.filter((f) => f.userId === 'ana').every((f) => f.revokedAt instanceof Date)).toBe(true)
        expect(tabla.refresh.find((f) => f.userId === 'beto')!.revokedAt).toBeNull()
        expect(tabla.sesiones.filter((s) => s.userId === 'ana').every((s) => s.revokedAt instanceof Date)).toBe(true)
        expect(tabla.sesiones.find((s) => s.userId === 'beto')!.revokedAt).toBeNull()
    })
})

describe('con better-auth real: la clave cambia → el refresh robado ya no renueva', () => {
    it('change-password (SIN revokeOtherSessions): renovar da «revoked»; el de otra persona sigue vivo', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        const beto = await m.alta('beto')
        conRefresh(ana.id, 'ROBADO', 'sa1')
        conRefresh(beto.id, 'DE-BETO', 'sb1')
        await m.auth.api.changePassword({
            headers: new Headers({ cookie: ana.cookie }),
            body: { currentPassword: 'una-clave-larga-123', newPassword: 'otra-clave-larga-456', revokeOtherSessions: false },
        })
        expect(await renovar('ROBADO')).toEqual({ ok: false, motivo: 'revoked' })
        const deBeto = await renovar('DE-BETO')
        expect(deBeto.ok).toBe(true)
    })

    it('change-password con la clave actual EQUIVOCADA: falla y el refresh sigue vivo', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'VIVO', 'sa1')
        await expect(
            m.auth.api.changePassword({
                headers: new Headers({ cookie: ana.cookie }),
                body: { currentPassword: 'no-es-esta', newPassword: 'otra-clave-larga-456' },
            }),
        ).rejects.toThrow()
        expect(tabla.refresh[0].revokedAt).toBeNull()
        expect((await renovar('VIVO')).ok).toBe(true)
    })

    it('reset-password con el enlace bueno: renovar da «revoked»; el de otra persona sigue vivo', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        const beto = await m.alta('beto')
        conRefresh(ana.id, 'ROBADO', 'sa1')
        conRefresh(beto.id, 'DE-BETO', 'sb1')
        // el enlace que mandaría `requestPasswordReset`
        m.db.verification.push({
            id: 'v1', identifier: 'reset-password:TOKEN-DEL-ENLACE', value: ana.id,
            expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(),
        })
        await m.auth.api.resetPassword({ body: { newPassword: 'clave-nueva-larga-789', token: 'TOKEN-DEL-ENLACE' } })
        expect(await renovar('ROBADO')).toEqual({ ok: false, motivo: 'revoked' })
        expect((await renovar('DE-BETO')).ok).toBe(true)
    })

    it('reset-password con un enlace INVÁLIDO: falla y no se cierra nada', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'VIVO', 'sa1')
        await expect(m.auth.api.resetPassword({ body: { newPassword: 'clave-nueva-larga-789', token: 'NO-EXISTE' } })).rejects.toThrow()
        expect(tabla.refresh[0].revokedAt).toBeNull()
    })

    it('si cerrar los refresh falla, la clave YA cambió: no revienta la respuesta y queda un error en el registro', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'VIVO', 'sa1')
        prismaFalso.refreshToken.findMany.mockRejectedValueOnce(new Error('base caída'))
        await expect(
            m.auth.api.changePassword({
                headers: new Headers({ cookie: ana.cookie }),
                body: { currentPassword: 'una-clave-larga-123', newPassword: 'otra-clave-larga-456' },
            }),
        ).resolves.toBeDefined()
        const { logger } = await import('@/lib/logger')
        expect(logger.error).toHaveBeenCalled()
    })
})

describe('si cerrar los refresh falla tras cambiar la clave, el aviso «revocada» sale igualmente', () => {
    const enlace = (m: Awaited<ReturnType<typeof mundo>>, id: string) =>
        m.db.verification.push({
            id: 'v1', identifier: 'reset-password:TOKEN-DEL-ENLACE', value: id,
            expiresAt: new Date(Date.now() + 3_600_000), createdAt: new Date(), updatedAt: new Date(),
        })

    it('reset-password: la clave cambia, la respuesta no revienta, se publica «revocada» y el error queda en el registro con el id interno', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'VIVO', 'sa1')
        enlace(m, ana.id)
        prismaFalso.refreshToken.findMany.mockRejectedValueOnce(new Error('base caída con ana@procovar.local'))
        await expect(m.auth.api.resetPassword({ body: { newPassword: 'clave-nueva-larga-789', token: 'TOKEN-DEL-ENLACE' } })).resolves.toBeDefined()
        expect(publicarSesionCerrada).toHaveBeenCalledWith([ana.id], 'revocada')
        const { logger } = await import('@/lib/logger')
        expect(logger.error).toHaveBeenCalledWith(expect.any(String), { userId: ana.id, error: 'Error' })
    })

    it('change-password con revokeOtherSessions: igual', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'VIVO', 'sa1')
        prismaFalso.refreshToken.findMany.mockRejectedValueOnce(new Error('base caída'))
        await expect(
            m.auth.api.changePassword({
                headers: new Headers({ cookie: ana.cookie }),
                body: { currentPassword: 'una-clave-larga-123', newPassword: 'otra-clave-larga-456', revokeOtherSessions: true },
            }),
        ).resolves.toBeDefined()
        expect(publicarSesionCerrada).toHaveBeenCalledWith([ana.id], 'revocada')
    })

    it('reset-password con `body.token` vacío y el enlace bueno en la query (better-auth usa `||`): cierra los refresh y avisa', async () => {
        const m = await mundo()
        const ana = await m.alta('ana')
        conRefresh(ana.id, 'ROBADO', 'sa1')
        enlace(m, ana.id)
        await m.auth.api.resetPassword({ body: { newPassword: 'clave-nueva-larga-789', token: '' }, query: { token: 'TOKEN-DEL-ENLACE' } })
        expect(await renovar('ROBADO')).toEqual({ ok: false, motivo: 'revoked' })
        expect(publicarSesionCerrada).toHaveBeenCalledWith([ana.id], 'revocada')
    })
})
