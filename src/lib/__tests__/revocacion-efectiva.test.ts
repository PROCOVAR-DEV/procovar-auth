/**
 * Una sesión revocada por un administrador (panel o servicio) deja de valer en TODAS partes.
 *
 * `revokedAt` es una columna nuestra: better-auth no la mira, y sólo `resolveSessionUser` y los dos
 * `verify-session` la comprobaban. `/api/auth/callback`, `/api/auth/exchange` y ~20 rutas (organizaciones,
 * rbac) llaman a `auth.api.getSession`, así que una sesión revocada seguía acuñando códigos SSO.
 * El arreglo: revocar pone TAMBIÉN `expiresAt = ahora`, que sí entiende better-auth.
 *
 * Aquí, better-auth DE VERDAD (adaptador en memoria) con la configuración y los hooks reales de
 * `lib/auth.ts`; los ocho caminos que marcan `revokedAt` se ejecutan de verdad contra una "base" que es
 * la MISMA tabla `session` que lee better-auth; y se comprueba lo que importa: `getSession` da null con la
 * cookie vieja y `/api/auth/callback` no acuña código.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'

// scrypt de better-auth + varios ficheros en paralelo: el límite por defecto (5 s) se queda corto en máquinas cargadas
vi.setConfig({ testTimeout: 30_000 })

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
    process.env.BEARER_TOKEN = 'otro-secreto-de-pruebas-de-mas-de-32-caracteres'
})

type Fila = Record<string, unknown>
const mundo = vi.hoisted(() => ({
    db: { user: [], session: [], account: [], verification: [] } as Record<string, Fila[]>,
    refresh: [] as Fila[],
    auth: null as unknown as { api: { getSession: (a: unknown) => Promise<unknown>; signUpEmail: (a: unknown) => Promise<{ response: { user: { id: string } }; headers: Headers }> } },
    real: null as unknown as { options: { session: unknown; hooks: unknown } },
}))
/** `where` de Prisma reducido a lo que se usa aquí: igualdad (null = ausente) e `in`. */
const cumple = (f: Fila, w: Fila) =>
    Object.entries(w).every(([k, v]) =>
        v && typeof v === 'object' && 'in' in v ? (v as { in: unknown[] }).in.includes(f[k]) : (f[k] ?? null) === v,
    )
const prismaFalso = vi.hoisted(() => {
    const sesiones = () => mundo.db.session
    return {
        user: { findUnique: vi.fn() },
        session: {
            findUnique: vi.fn(async ({ where }: { where: Fila }) => sesiones().find((f) => cumple(f, where)) ?? null),
            findMany: vi.fn(async ({ where }: { where: Fila }) => sesiones().filter((f) => cumple(f, where))),
            update: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
                const f = sesiones().find((x) => cumple(x, where))
                if (!f) throw new Error('no existe')
                return Object.assign(f, data)
            }),
            updateMany: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
                const filas = sesiones().filter((f) => cumple(f, where))
                filas.forEach((f) => Object.assign(f, data))
                return { count: filas.length }
            }),
        },
        refreshToken: {
            findUnique: vi.fn(async ({ where }: { where: Fila }) => mundo.refresh.find((f) => cumple(f, where)) ?? null),
            findFirst: vi.fn(async ({ where }: { where: Fila }) => mundo.refresh.find((f) => cumple(f, where)) ?? null),
            findMany: vi.fn(async ({ where }: { where: Fila }) => mundo.refresh.filter((f) => cumple(f, where)).map((f) => ({ sessionId: f.sessionId }))),
            updateMany: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => {
                const filas = mundo.refresh.filter((f) => cumple(f, where))
                filas.forEach((f) => Object.assign(f, data))
                return { count: filas.length }
            }),
            update: vi.fn(async ({ where, data }: { where: Fila; data: Fila }) => Object.assign(mundo.refresh.find((f) => cumple(f, where))!, data)),
            create: vi.fn(async ({ data }: { data: Fila }) => {
                const f = { id: `nuevo${mundo.refresh.length}`, usedAt: null, revokedAt: null, graceUsedAt: null, ...data }
                mundo.refresh.push(f)
                return f
            }),
        },
        account: { findFirst: vi.fn(async () => ({ id: 'acc' })), update: vi.fn(async () => ({})), create: vi.fn() },
    }
})
const galletas = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn(), cabecera: '' }))
const codigos = vi.hoisted(() => ({ createAuthCode: vi.fn(async () => ({ code: 'CODIGO', expiresIn: 60 })) }))
const redisFalso = vi.hoisted(() => ({ set: vi.fn(async () => 'OK'), pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })) }))

vi.mock('@/lib/prisma', () => ({ prisma: prismaFalso }))
vi.mock('@/lib/redis', () => ({ getRedis: () => redisFalso }))
vi.mock('@/lib/eventos-de-sesion', () => ({ publicarSesionCerrada: vi.fn(async () => {}) }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/historial-de-inicios', () => ({ auditarInicioWeb: vi.fn(async () => {}) }))
vi.mock('@/lib/with-service-auth', () => ({
    withServiceAuth: (h: (r: unknown, c: unknown) => unknown) => (r: unknown) => h(r, { client: { clientId: 'servicio' } }),
}))
vi.mock('next/headers', () => ({
    cookies: vi.fn(async () => galletas),
    headers: vi.fn(async () => new Headers({ cookie: galletas.cabecera })),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/auth-code', () => codigos)
vi.mock('@/lib/callback-validator', () => ({ validateCallbackPayload: vi.fn(async () => ({})), CallbackValidationError: class extends Error {} }))
vi.mock('@/lib/puerta-de-entrada', async (o) => ({ ...(await o<object>()), puedeEntrar: vi.fn(async () => true) }))
// `lib/auth.ts` real da la configuración (sesión, hooks); la instancia que se usa es la de memoria, de `mundo.auth`.
vi.mock('@/lib/auth', async (original) => {
    const real = await original<{ auth: typeof mundo.real }>()
    mundo.real = real.auth
    return { ...real, auth: { api: { getSession: (a: unknown) => mundo.auth.api.getSession(a) } } }
})
// El panel: el administrador que llama.
vi.mock('@/server/auth.server', () => ({ getCurrentUser: vi.fn(async () => ({ data: { id: 'admin', isSystemAdmin: true } })) }))
vi.mock('@/lib/alta-persona', () => ({ altaPersona: vi.fn(), esSuperAdmin: vi.fn(() => false) }))
vi.mock('@/rbac/en-sucursal', () => ({ rbacEnSucursal: vi.fn(async () => ({})), rolesEnSucursal: vi.fn(async () => []) }))
vi.mock('@/rbac/can', () => ({ can: () => true }))
vi.mock('@/rbac/escalafon', () => ({ puedeRepartirRol: () => true }))
vi.mock('better-auth/crypto', () => ({ hashPassword: vi.fn(async () => 'hash') }))

import { getSessionCookieName } from '@/lib/flow-state'
import { GET as callback } from '@/app/api/auth/callback/route'
import { POST as revocarPorServicio } from '@/app/api/auth/revoke-session/route'
import { cambiarContrasena, revokeAllUserSessions, revokeUserSession } from '@/app/(user)/dashboard/_actions'
import { cerrarFamilia, cerrarTodasLasFamiliasDe, renovar, revocarTodasLasSesiones, SEGUNDOS_REFRESH } from '@/lib/apk-tokens'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Una persona con su sesión web abierta (better-auth real), un refresh ligado a ella, y su cookie. */
async function conSesion(nombre = 'ana') {
    const r = await mundo.auth.api.signUpEmail({
        body: { email: `${nombre}@procovar.local`, password: 'una-clave-larga-123', name: nombre },
        returnHeaders: true,
    } as never)
    const userId = r.response.user.id as string
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c: string) => c.split(';')[0]).join('; ')
    const sesion = mundo.db.session.find((s) => s.userId === userId)!
    mundo.refresh.push({
        id: `rt-${nombre}`, userId, sessionId: sesion.id, familyId: `fam-${nombre}`, clientId: 'delivery-apk', tokenHash: sha(`RAW-${nombre}`),
        expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000), usedAt: null, revokedAt: null, graceUsedAt: null,
    })
    return { userId, cookie, sesionId: sesion.id as string }
}
const leer = (cookie: string) => mundo.auth.api.getSession({ headers: new Headers({ cookie }) })

/** `/api/auth/callback` con esa cookie y un flujo válido: ¿acuña código? */
async function acuñaCodigo(cookie: string) {
    codigos.createAuthCode.mockClear()
    galletas.cabecera = cookie
    const flujo = { clientId: 'aft', origin: 'https://app.example.com/auth/callback', redirectOrigin: true }
    galletas.get.mockImplementation((n: string) =>
        n === 'qb.flow_state' ? { value: JSON.stringify(flujo) } : n === getSessionCookieName() ? { value: 'tok' } : undefined,
    )
    await callback()
    return codigos.createAuthCode.mock.calls.length > 0
}

beforeEach(async () => {
    vi.clearAllMocks()
    for (const k of Object.keys(mundo.db)) mundo.db[k].length = 0
    mundo.refresh.length = 0
    const real = mundo.real
    mundo.auth = betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter(mundo.db),
        emailAndPassword: { enabled: true },
        session: real.options.session,
        hooks: real.options.hooks,
    } as never) as never
    prismaFalso.user.findUnique.mockResolvedValue(null)
})

const peticionServicio = (cuerpo: unknown) => ({ json: async () => cuerpo }) as never

/** Cada camino que marca `revokedAt` en una sesión, ejecutado de verdad. */
const caminos: [string, (p: { userId: string; sesionId: string }) => Promise<unknown>][] = [
    ['POST /api/auth/revoke-session {sessionId}', (p) => revocarPorServicio(peticionServicio({ sessionId: p.sesionId }))],
    ['POST /api/auth/revoke-session {userId}', async (p) => { prismaFalso.user.findUnique.mockResolvedValue({ id: p.userId }); await revocarPorServicio(peticionServicio({ userId: p.userId })) }],
    ['panel: revokeUserSession', (p) => revokeUserSession(p.sesionId)],
    ['panel: revokeAllUserSessions', (p) => revokeAllUserSessions(p.userId)],
    ['panel: cambiarContrasena', (p) => cambiarContrasena(p.userId, 'una-clave-nueva-larga')],
    ['apk-tokens: revocarTodasLasSesiones', (p) => revocarTodasLasSesiones(p.userId, 'prueba')],
    ['apk-tokens: cerrarFamilia', () => cerrarFamilia('fam-ana')],
    ['apk-tokens: cerrarTodasLasFamiliasDe', (p) => cerrarTodasLasFamiliasDe(p.userId)],
]

describe('revocar por cualquier camino: la cookie vieja ya no vale en ninguna ruta', () => {
    it('CONTROL: antes de revocar, getSession da la sesión y el callback acuña código (la prueba distingue)', async () => {
        const { cookie } = await conSesion()
        expect(await leer(cookie)).not.toBeNull()
        expect(await acuñaCodigo(cookie)).toBe(true)
    })

    it.each(caminos)('%s → getSession da null y /api/auth/callback NO acuña código', async (_n, revocar) => {
        const ana = await conSesion('ana')
        const beto = await conSesion('beto') // otra persona: no se toca
        await revocar(ana)
        const fila = mundo.db.session.find((s) => s.id === ana.sesionId)!
        expect(fila.revokedAt).toBeInstanceOf(Date) // sigue marcada: el panel la ve como revocada
        expect((fila.expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now())
        expect(await leer(ana.cookie)).toBeNull()
        expect(await acuñaCodigo(ana.cookie)).toBe(false)
        // y la de otra persona sigue entera
        expect(await leer(beto.cookie)).not.toBeNull()
        expect((mundo.db.session.find((s) => s.id === beto.sesionId)!.expiresAt as Date).getTime()).toBeGreaterThan(Date.now())
    })
})

describe('renovar no resucita una sesión revocada', () => {
    it('si la revocan entre la comprobación y el estirón de `expiresAt`, la sesión sigue caducada', async () => {
        const ana = await conSesion('ana')
        prismaFalso.user.findUnique.mockResolvedValue({
            id: ana.userId, name: 'ana', email: 'ana@procovar.local', username: 'ana', activo: true, isSystemAdmin: false,
            defaultRole: { name: 'OPERADOR', permissions: [{ permission: { key: 'delivery.entrar' } }] },
            members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [{ role: { name: 'OPERADOR' } }] }],
        })
        // Revocada a mano…
        const ahora = new Date()
        Object.assign(mundo.db.session.find((s) => s.id === ana.sesionId)!, { revokedAt: ahora, expiresAt: ahora })
        // …pero `renovar` leyó la fila un instante antes (lectura vieja: aún sin revocar).
        prismaFalso.session.findUnique.mockResolvedValueOnce({ revokedAt: null } as never)
        const r = await renovar('RAW-ana')
        expect(r.ok).toBe(true) // la carrera existe: pasó la comprobación
        expect((mundo.db.session.find((s) => s.id === ana.sesionId)!.expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now())
        expect(await leer(ana.cookie)).toBeNull()
    })
})
