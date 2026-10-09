/**
 * Una cuenta de BAJA (`activo=false`) no abre sesión. Con better-auth DE VERDAD (adaptador en memoria) y el
 * `databaseHooks` REAL de `lib/auth.ts`: la persona activa entra, la de baja no, y el error es IDÉNTICO al de
 * una contraseña mala (el hook corre cuando la clave ya es buena: otro mensaje la confirmaría).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'

// scrypt de better-auth + varios ficheros en paralelo: el límite por defecto (5 s) se queda corto en máquinas cargadas
vi.setConfig({ testTimeout: 30_000 })

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})

const db = vi.hoisted(() => ({ user: [], session: [], account: [], verification: [] }) as Record<string, Record<string, unknown>[]>)
const prismaFalso = vi.hoisted(() => ({
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const u = db.user.find((x) => x.id === where.id)
        return u ? { activo: u.activo ?? true } : null // como Prisma: la columna vale true si nadie la tocó
    }) },
}))
vi.mock('@/lib/prisma', () => ({ prisma: prismaFalso }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/historial-de-inicios', () => ({ auditarInicioWeb: vi.fn(async () => {}) }))

const CLAVE = 'una-clave-larga-123'

async function mundo() {
    const { auth: real } = await import('@/lib/auth')
    for (const k of Object.keys(db)) db[k].length = 0
    return betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        databaseHooks: real.options.databaseHooks, // el REAL
    })
}
const entrar = (auth: Awaited<ReturnType<typeof mundo>>, email: string, password: string) =>
    auth.api.signInEmail({ body: { email, password }, headers: new Headers({ 'user-agent': 'prueba' }) })
const fallo = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (x) => x)) as { status?: unknown; statusCode?: unknown; body?: unknown; message?: string } | null
    return e && { status: e.status, statusCode: e.statusCode, body: e.body, message: e.message }
}

beforeEach(() => vi.clearAllMocks())

describe('la cuenta de baja no inicia sesión', () => {
    it('CONTROL: una persona activa se da de alta y entra', async () => {
        const auth = await mundo()
        await auth.api.signUpEmail({ body: { email: 'ana@procovar.local', password: CLAVE, name: 'Ana' } })
        const r = await entrar(auth, 'ana@procovar.local', CLAVE)
        expect(r.user.email).toBe('ana@procovar.local')
        expect(db.session).toHaveLength(2) // el alta y la entrada
    })

    it('de baja, con la clave BUENA: no entra, no se crea sesión y el error es el mismo que con la clave mala o sin cuenta', async () => {
        const auth = await mundo()
        await auth.api.signUpEmail({ body: { email: 'ana@procovar.local', password: CLAVE, name: 'Ana' } })
        db.user.find((u) => u.email === 'ana@procovar.local')!.activo = false
        const sesionesAntes = db.session.length

        const deBaja = await fallo(entrar(auth, 'ana@procovar.local', CLAVE))
        expect(deBaja).not.toBeNull()
        expect(db.session).toHaveLength(sesionesAntes)

        const claveMala = await fallo(entrar(auth, 'ana@procovar.local', 'otra-clave-mala-999'))
        const sinCuenta = await fallo(entrar(auth, 'nadie@procovar.local', CLAVE))
        expect(claveMala).not.toBeNull()
        expect(deBaja).toEqual(claveMala)
        expect(deBaja).toEqual(sinCuenta)
    })

    it('al volver a darla de alta (activo=true) entra otra vez', async () => {
        const auth = await mundo()
        await auth.api.signUpEmail({ body: { email: 'ana@procovar.local', password: CLAVE, name: 'Ana' } })
        const fila = db.user.find((u) => u.email === 'ana@procovar.local')!
        fila.activo = false
        expect(await fallo(entrar(auth, 'ana@procovar.local', CLAVE))).not.toBeNull()
        fila.activo = true
        expect((await entrar(auth, 'ana@procovar.local', CLAVE)).user.email).toBe('ana@procovar.local')
    })

    it('otra persona activa no se ve afectada por la baja de ana', async () => {
        const auth = await mundo()
        await auth.api.signUpEmail({ body: { email: 'ana@procovar.local', password: CLAVE, name: 'Ana' } })
        await auth.api.signUpEmail({ body: { email: 'beto@procovar.local', password: CLAVE, name: 'Beto' } })
        db.user.find((u) => u.email === 'ana@procovar.local')!.activo = false
        expect((await entrar(auth, 'beto@procovar.local', CLAVE)).user.email).toBe('beto@procovar.local')
    })
})
