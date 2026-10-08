/**
 * LA PUERTA, vista desde fuera en las tres vías por las que Accesos entrega el
 * código de entrada: `/api/auth/callback`, la ruta vieja `?op=` de la página, y el
 * login de la APK. La decisión (`puedeEntrar`) tiene sus pruebas en
 * `lib/__tests__/puerta-de-entrada.test.ts`; aquí se comprueba el CABLEADO: que sin la
 * llave no se acuña nada, que con ella sale exactamente igual que antes, y que no hay bucle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Los imports se evalúan antes que el resto del fichero: el entorno va en un bloque izado.
vi.hoisted(() => {
    process.env.APP_URL = 'https://auth.example.com'
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.BEARER_TOKEN = 'otro-secreto-de-pruebas-de-mas-de-32-caracteres'
})

const galletas = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }))
const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() }, session: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() } }))
const betterAuth = vi.hoisted(() => ({ getSession: vi.fn(), signInEmail: vi.fn() }))
const codigos = vi.hoisted(() => ({ createAuthCode: vi.fn() }))
const auditoria = vi.hoisted(() => ({ audit: vi.fn() }))
const apk = vi.hoisted(() => ({ emitirPar: vi.fn() }))
const pagina = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    decodeFlowOptions: vi.fn(),
    getFlowState: vi.fn(),
    buildExternalRedirectUrl: vi.fn(),
    validateCallbackPayload: vi.fn(),
}))

vi.mock('next/headers', () => ({ cookies: vi.fn(async () => galletas), headers: vi.fn(async () => new Headers()) }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/auth-code', () => codigos)
vi.mock('@/lib/audit', () => auditoria)
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn(async () => ({ allowed: true, remaining: 10 })) }))
vi.mock('@/lib/apk-tokens', async (original) => ({ ...(await original<object>()), emitirPar: apk.emitirPar }))
// La página (ruta vieja ?op=): se aíslan sus dependencias de pantalla y de flujo.
vi.mock('next/navigation', () => ({
    redirect: (u: string) => {
        throw new Error(`REDIRECT:${u}`)
    },
}))
vi.mock('@/components/pantalla-de-entrada', () => ({ PantallaDeEntrada: () => null }))
vi.mock('@/components/account-view', () => ({ AccountView: () => null }))
vi.mock('@/server/auth.server', () => ({ getCurrentUser: pagina.getCurrentUser }))
vi.mock('@/lib/callback-validator', () => ({
    validateCallbackPayload: pagina.validateCallbackPayload,
    CallbackValidationError: class extends Error {},
}))
vi.mock('@/lib/role-resolver', () => ({ resolveProfileRole: vi.fn(async () => 'client') }))
vi.mock('@/lib/flow-state', async (original) => ({
    ...(await original<object>()),
    decodeFlowOptions: pagina.decodeFlowOptions,
    getFlowState: pagina.getFlowState,
    buildExternalRedirectUrl: pagina.buildExternalRedirectUrl,
}))

import { GET as callback } from '../callback/route'
import { POST as token } from '../token/route'
import SignInPage from '@/app/(user)/page'

const FLOW = 'qb.flow_state'
const SESION = '__Secure-qb.session_token'

/** Lo que la persona tiene: sus llaves (rol por defecto) y si es administradora de sistema. */
const laPersonaTiene = (llaves: string[], admin = false) =>
    db.user.findUnique.mockResolvedValue({
        isSystemAdmin: admin,
        defaultRole: { permissions: llaves.map((key) => ({ permission: { key } })) },
        members: [],
    })

function flujo(clientId: string | undefined, extra: Record<string, unknown> = {}) {
    const valor = { clientId, origin: 'https://app.example.com/auth/callback', redirectOrigin: true, ...extra }
    galletas.get.mockImplementation((n: string) =>
        n === FLOW ? { value: JSON.stringify(valor) } : n === SESION || n === 'qb.session_token' ? { value: 'tok' } : undefined,
    )
}

beforeEach(() => {
    vi.resetAllMocks()
    betterAuth.getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } })
    codigos.createAuthCode.mockResolvedValue({ code: 'CODIGO', expiresIn: 60 })
})

describe('GET /api/auth/callback', () => {
    const lanzar = async () => callback()
    const destino = (r: Response) => new URL(r.headers.get('location')!)

    it('SIN la llave: no se acuña el código, se va a la pantalla de Accesos y se audita', async () => {
        flujo('procovar-rutas')
        laPersonaTiene(['pedido.entrar'])

        const r = await lanzar()

        expect(codigos.createAuthCode).not.toHaveBeenCalled()
        expect(destino(r).origin).toBe('https://auth.example.com')
        expect(destino(r).pathname).toBe('/sin-permiso')
        expect(destino(r).searchParams.get('app')).toBe('procovar-rutas')
        expect(destino(r).searchParams.has('code')).toBe(false)
        expect(auditoria.audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.code.denied', clientId: 'procovar-rutas', userId: 'u1' }),
        )
        expect(auditoria.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.code.create' }))
    })

    it('NO hay bucle: la galleta de flujo se borra y el destino no relanza el flujo', async () => {
        flujo('aft')
        laPersonaTiene([])

        const r = await lanzar()

        expect(galletas.delete).toHaveBeenCalledWith(FLOW)
        expect(['/api/flow', '/api/auth/callback', '/']).not.toContain(destino(r).pathname)
    })

    it('CON la llave: el código y la redirección salen exactamente como antes', async () => {
        flujo('procovar-rutas')
        laPersonaTiene(['rutas.entrar'])

        const r = await lanzar()

        expect(codigos.createAuthCode).toHaveBeenCalledWith({
            userId: 'u1',
            sessionId: 's1',
            sessionToken: 'tok',
            clientId: 'procovar-rutas',
            callbackUrl: 'https://app.example.com/auth/callback',
            returnTo: null,
        })
        expect(r.headers.get('location')).toBe('https://app.example.com/auth/callback?code=CODIGO')
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.code.create' }))
    })

    it('el administrador de sistema entra sin llaves', async () => {
        flujo('aft')
        laPersonaTiene([], true)
        const r = await lanzar()
        expect(r.headers.get('location')).toBe('https://app.example.com/auth/callback?code=CODIGO')
    })

    it('un clientId sin mapa (asignacion) entra como hoy, sin tocar la base de personas', async () => {
        flujo('asignacion')
        const r = await lanzar()
        expect(r.headers.get('location')).toBe('https://app.example.com/auth/callback?code=CODIGO')
        expect(db.user.findUnique).not.toHaveBeenCalled()
    })

    describe('la galleta de flujo NO está firmada: se vuelve a validar como lo hizo /api/flow', () => {
        const sinCodigo = (r: Response) => {
            expect(codigos.createAuthCode).not.toHaveBeenCalled()
            expect(destino(r).origin).toBe('https://auth.example.com')
            expect(destino(r).pathname).toBe('/sin-permiso')
            expect(destino(r).searchParams.has('code')).toBe(false)
            expect(galletas.delete).toHaveBeenCalledWith(FLOW)
            expect(auditoria.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.code.create' }))
        }

        it('se valida con el clientId y el origin de la galleta (y su returnTo)', async () => {
            flujo('pedido', { returnTo: 'https://pedidos.example.com/x' })
            laPersonaTiene(['pedido.entrar'])
            await lanzar()
            expect(pagina.validateCallbackPayload).toHaveBeenCalledWith({
                clientId: 'pedido',
                callbackUrl: 'https://app.example.com/auth/callback',
                returnTo: 'https://pedidos.example.com/x',
            })
        })

        it('sin clientId (galleta editada para saltarse la puerta): no hay código', async () => {
            flujo(undefined)
            pagina.validateCallbackPayload.mockRejectedValue(new Error('missing_client_id'))
            const r = await lanzar()
            sinCodigo(r)
            expect(pagina.validateCallbackPayload).toHaveBeenCalledWith(expect.objectContaining({ clientId: '' }))
        })

        it('con clientId `asignacion` (sin llave) pero un origin que no es suyo: no hay código', async () => {
            flujo('asignacion', { origin: 'https://evil.example.com/cb' })
            pagina.validateCallbackPayload.mockRejectedValue(new Error('callback_not_allowed'))
            sinCodigo(await lanzar())
        })

        it('si ni se puede validar (la base cae): no hay código (falla cerrado)', async () => {
            flujo('procovar-rutas')
            laPersonaTiene(['rutas.entrar'])
            pagina.validateCallbackPayload.mockRejectedValue(new Error('base caída'))
            sinCodigo(await lanzar())
        })

        it('la validación va ANTES de la puerta: un flujo inválido no llega ni a mirar las llaves', async () => {
            flujo('aft')
            pagina.validateCallbackPayload.mockRejectedValue(new Error('unknown_client'))
            await lanzar()
            expect(db.user.findUnique).not.toHaveBeenCalled()
        })
    })

    describe('prompt=none (sondeo silencioso) con la persona dentro pero SIN la llave', () => {
        it('vuelve a la aplicación con ?sso=none: ni código ni pantalla de Accesos', async () => {
            flujo('procovar-rutas', { prompt: 'none' })
            laPersonaTiene(['pedido.entrar'])

            const r = await lanzar()

            expect(codigos.createAuthCode).not.toHaveBeenCalled()
            expect(r.headers.get('location')).toBe('https://app.example.com/auth/callback?sso=none')
            expect(galletas.delete).toHaveBeenCalledWith(FLOW)
            expect(auditoria.audit).toHaveBeenCalledWith(
                expect.objectContaining({ action: 'auth.code.denied', clientId: 'procovar-rutas', userId: 'u1' }),
            )
        })

        it('devuelve también el returnTo, como /api/flow/none', async () => {
            flujo('procovar-rutas', { prompt: 'none', returnTo: 'https://rutas.example.com/mapa' })
            laPersonaTiene([])
            const u = destino(await lanzar())
            expect(u.origin + u.pathname).toBe('https://app.example.com/auth/callback')
            expect(u.searchParams.get('sso')).toBe('none')
            expect(u.searchParams.get('returnTo')).toBe('https://rutas.example.com/mapa')
            expect(u.searchParams.has('code')).toBe(false)
        })

        it('CON la llave el sondeo recibe su código, como siempre', async () => {
            flujo('procovar-rutas', { prompt: 'none' })
            laPersonaTiene(['rutas.entrar'])
            expect((await lanzar()).headers.get('location')).toBe('https://app.example.com/auth/callback?code=CODIGO')
        })

        it('sin prompt=none sigue yendo a la pantalla de Accesos (no se confunde)', async () => {
            flujo('procovar-rutas')
            laPersonaTiene([])
            const u = destino(await lanzar())
            expect(u.pathname).toBe('/sin-permiso')
            expect(u.searchParams.has('sso')).toBe(false)
        })
    })

    it('si la base falla, NO hay código (falla cerrado)', async () => {
        flujo('procovar-rutas')
        db.user.findUnique.mockRejectedValue(new Error('base caída'))

        const r = await lanzar()

        expect(codigos.createAuthCode).not.toHaveBeenCalled()
        expect(destino(r).pathname).toBe('/sin-permiso')
        expect(galletas.delete).toHaveBeenCalledWith(FLOW)
    })
})

describe('la página, ruta vieja ?op=', () => {
    const op = { clientId: 'pedido', origin: 'https://pedidos.example.com/cb', redirectOrigin: true }
    const entrar = () => SignInPage({ searchParams: Promise.resolve({ op: 'x' }) })

    beforeEach(() => {
        pagina.getCurrentUser.mockResolvedValue({ data: { id: 'u1', isSystemAdmin: false } })
        pagina.decodeFlowOptions.mockResolvedValue(op)
        pagina.validateCallbackPayload.mockResolvedValue(undefined)
        pagina.buildExternalRedirectUrl.mockResolvedValue('https://pedidos.example.com/cb?code=VIEJO')
        galletas.get.mockReturnValue({ value: 'tok' })
    })

    it('SIN la llave: no se acuña el código y se va a la pantalla de Accesos', async () => {
        laPersonaTiene(['analitics.entrar'])
        await expect(entrar()).rejects.toThrow('REDIRECT:/sin-permiso?app=pedido')
        expect(pagina.buildExternalRedirectUrl).not.toHaveBeenCalled()
        expect(auditoria.audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.code.denied', clientId: 'pedido', userId: 'u1' }),
        )
    })

    it('CON la llave: redirige a la aplicación con su código, como antes', async () => {
        laPersonaTiene(['pedido.entrar'])
        await expect(entrar()).rejects.toThrow('REDIRECT:https://pedidos.example.com/cb?code=VIEJO')
        expect(pagina.buildExternalRedirectUrl).toHaveBeenCalledWith('https://pedidos.example.com/cb', 'tok')
    })

    it('el administrador de sistema entra; la base caída deniega', async () => {
        laPersonaTiene([], true)
        await expect(entrar()).rejects.toThrow('REDIRECT:https://pedidos.example.com/cb?code=VIEJO')

        pagina.buildExternalRedirectUrl.mockClear()
        db.user.findUnique.mockRejectedValue(new Error('base caída'))
        await expect(entrar()).rejects.toThrow('REDIRECT:/sin-permiso?app=pedido')
        expect(pagina.buildExternalRedirectUrl).not.toHaveBeenCalled()
    })
})

describe('POST /api/auth/token (login de la APK)', () => {
    const peticion = () =>
        ({ headers: new Headers({ 'user-agent': 'reparto/1.0' }), json: async () => ({ email: 'y@p.local', password: 'buena' }) }) as never
    const entrar = async () => {
        const res = await token(peticion())
        return { status: res.status, body: await res.json() }
    }

    beforeEach(() => {
        betterAuth.signInEmail.mockResolvedValue({ token: 'tok-de-sesion' })
        db.session.findUnique.mockResolvedValue({ id: 's1', userId: 'u1' })
        db.session.updateMany.mockResolvedValue({ count: 1 })
        apk.emitirPar.mockResolvedValue({ token: 'T', refresh_token: 'R', token_type: 'Bearer', expires_in: 900, refresh_expires_in: 2592000 })
    })

    it('SIN delivery.entrar: 403 sin_permiso, no se emite el par y se audita', async () => {
        laPersonaTiene(['pedido.entrar'])

        const r = await entrar()

        expect(r.status).toBe(403)
        expect(r.body.codigo).toBe('sin_permiso')
        expect(r.body.error).toBe('sin_permiso')
        expect(r.body.token).toBeUndefined()
        expect(apk.emitirPar).not.toHaveBeenCalled()
        expect(auditoria.audit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.apk.denied', clientId: 'delivery-apk', userId: 'u1' }),
        )
        expect(auditoria.audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.login' }))
    })

    it('CON delivery.entrar: sale el par, como antes', async () => {
        laPersonaTiene(['delivery.entrar'])
        const r = await entrar()
        expect(r.status).toBe(200)
        expect(r.body.token).toBe('T')
        expect(auditoria.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'auth.apk.login' }))
    })

    it('el administrador de sistema entra; la base caída NO es «sin permiso»: 503', async () => {
        laPersonaTiene([], true)
        expect((await entrar()).status).toBe(200)

        apk.emitirPar.mockClear()
        db.user.findUnique.mockRejectedValue(new Error('base caída'))
        const r = await entrar()
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(apk.emitirPar).not.toHaveBeenCalled()
        // La sesión que abrió este intento no se queda colgada.
        expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { id: 's1' } })
    })
})
