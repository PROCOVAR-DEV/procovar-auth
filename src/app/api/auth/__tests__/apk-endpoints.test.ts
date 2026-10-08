/**
 * Las tres puertas de la APK, vistas desde fuera.
 *
 * Aquí no se vuelve a probar la lógica del par —eso está en
 * `lib/__tests__/apk-tokens.test.ts`— sino lo que sólo se ve en la respuesta:
 * que un fallo de contraseña no cuente si la cuenta existe, que el limitador
 * corte antes de llegar a comprobar nada, y que todos los fallos de renovación
 * salgan con la misma cara.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decodeJwt } from 'jose'

process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
process.env.APP_URL = 'https://auth.example.com'

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    session: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
}))
const betterAuth = vi.hoisted(() => ({ signInEmail: vi.fn() }))
const limitador = vi.hoisted(() => ({ rateLimit: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/auth', () => ({ auth: { api: betterAuth } }))
vi.mock('@/lib/rate-limit', () => limitador)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { POST as token } from '../token/route'
import { POST as refresh } from '../refresh/route'
import { POST as logout } from '../logout/route'
import { SEGUNDOS_REFRESH } from '@/lib/apk-tokens'

type Ruta = (req: never) => Promise<Response>

function peticion(body: unknown, cabeceras: Record<string, string> = {}) {
    return {
        headers: new Headers({ 'user-agent': 'reparto/1.0', ...cabeceras }),
        json: async () => body,
    } as never
}

async function llamar(ruta: Ruta, body: unknown, cabeceras?: Record<string, string>) {
    const res = await ruta(peticion(body, cabeceras))
    return { status: res.status, body: await res.json() }
}

const PERSONA = {
    id: 'u1',
    name: 'Yasmani',
    email: 'Yasmani@Procovar.Local',
    username: 'yasmani',
    activo: true,
    isSystemAdmin: false,
    // La puerta (`puerta-de-entrada.ts`) pide `delivery.entrar` antes de emitir el par.
    defaultRole: { name: 'OPERADOR', permissions: [{ permission: { key: 'delivery.entrar' } }] },
    members: [
        {
            organization: { codigo: 'CAM', activa: true },
            memberRoles: [{ role: { name: 'OPERADOR' } }],
        },
    ],
}

beforeEach(() => {
    vi.resetAllMocks()
    limitador.rateLimit.mockResolvedValue({ allowed: true, remaining: 10 })
    betterAuth.signInEmail.mockResolvedValue({ token: 'tok-de-sesion' })
    db.session.findUnique.mockResolvedValue({ id: 's1', userId: 'u1' })
    db.session.updateMany.mockResolvedValue({ count: 1 })
    db.user.findUnique.mockResolvedValue(PERSONA)
    db.refreshToken.create.mockResolvedValue({ id: 'rt-nuevo' })
    db.refreshToken.updateMany.mockResolvedValue({ count: 1 })
    db.refreshToken.update.mockResolvedValue({})
})

describe('POST /api/auth/token', () => {
    it('devuelve el par, con la sucursal y los roles dentro del token', async () => {
        const r = await llamar(token, { email: 'Yasmani@Procovar.Local', password: 'buena' })

        expect(r.status).toBe(200)
        expect(r.body.token_type).toBe('Bearer')
        expect(r.body.refresh_token).toEqual(expect.any(String))

        const c = decodeJwt(r.body.token)
        expect(c.sub).toBe('u1')
        expect(c.sucursal).toBe('CAM')
        expect(c.roles).toEqual(['OPERADOR'])
    })

    it('una contraseña mala NO dice si la cuenta existe', async () => {
        // Los dos casos tienen que salir idénticos: mismo código y mismo cuerpo,
        // byte a byte. Cualquier diferencia —un texto distinto, un 404 en vez de
        // un 401— convierte este endpoint en una lista de quién trabaja aquí.
        betterAuth.signInEmail.mockRejectedValue(new Error('User not found'))
        db.user.findUnique.mockResolvedValue(null)
        const noExiste = await llamar(token, { username: 'nadie', password: 'x' })

        vi.clearAllMocks()
        limitador.rateLimit.mockResolvedValue({ allowed: true, remaining: 10 })
        betterAuth.signInEmail.mockRejectedValue(new Error('Invalid password'))
        db.user.findUnique.mockResolvedValue(PERSONA)
        const malaClave = await llamar(token, { username: 'yasmani', password: 'x' })

        expect(noExiste.status).toBe(401)
        expect(malaClave).toEqual(noExiste)
        expect(JSON.stringify(malaClave.body)).toBe(JSON.stringify(noExiste.body))
    })

    it('el correo va TAL CUAL, sin minusculizar', async () => {
        // Minusculizarlo aquí sería una segunda regla, distinta de la del login de
        // la web, y por tanto una cuenta que entra por un sitio y no por el otro.
        await llamar(token, { email: 'Yasmani@Procovar.Local', password: 'buena' })
        expect(betterAuth.signInEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({ email: 'Yasmani@Procovar.Local' }),
            })
        )
    })

    it('un nombre de usuario se cambia por su correo antes de comprobar nada', async () => {
        await llamar(token, { username: 'yasmani', password: 'buena' })
        expect(db.user.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { username: 'yasmani' } })
        )
        expect(betterAuth.signInEmail).toHaveBeenCalledWith(
            expect.objectContaining({
                body: expect.objectContaining({ email: 'Yasmani@Procovar.Local' }),
            })
        )
    })

    it('un nombre que no existe sigue adelante, para que el fallo sea el mismo', async () => {
        db.user.findUnique.mockResolvedValue(null)
        betterAuth.signInEmail.mockRejectedValue(new Error('Invalid email'))

        const r = await llamar(token, { username: 'nadie', password: 'x' })

        expect(betterAuth.signInEmail).toHaveBeenCalled()
        expect(r).toEqual({ status: 401, body: { error: 'invalid_credentials' } })
    })

    it('el limitador corta ANTES de comprobar la contraseña', async () => {
        limitador.rateLimit.mockResolvedValue({ allowed: false, remaining: 0 })

        const r = await llamar(token, { email: 'a@b.c', password: 'x' })

        expect(r.status).toBe(429)
        expect(betterAuth.signInEmail).not.toHaveBeenCalled()
    })

    it('limita por cuenta además de por IP', async () => {
        // Repartir los intentos entre muchas IP es lo que hace inútil un límite
        // que sólo mire de dónde viene la petición.
        await llamar(token, { email: 'a@b.c', password: 'x' })
        const ambitos = limitador.rateLimit.mock.calls.map(([o]) => o.scope)
        expect(ambitos).toContain('apk-token-ip')
        expect(ambitos).toContain('apk-token-cuenta')
    })

    it('si el limitador no contesta, NO se pasa', async () => {
        // En la única puerta que acepta contraseñas, quedarse sin límite es peor
        // que quedarse sin servicio un rato.
        limitador.rateLimit.mockRejectedValue(new Error('redis caído'))

        const r = await llamar(token, { email: 'a@b.c', password: 'x' })

        expect(r.status).toBe(503)
        expect(betterAuth.signInEmail).not.toHaveBeenCalled()
    })

    it('a quien no tiene sucursal no se le firma un token, y se le dice por qué', async () => {
        db.user.findUnique.mockResolvedValue({ ...PERSONA, members: [] })

        const r = await llamar(token, { email: 'a@b.c', password: 'buena' })

        expect(r.status).toBe(403)
        expect(r.body.error).toBe('sin_sucursal')
        expect(db.refreshToken.create).not.toHaveBeenCalled()
        // Y la sesión que abrió este intento no se queda: sólo esa, por su id.
        expect(db.session.deleteMany).toHaveBeenCalledWith({ where: { id: 's1' } })
    })

    it('estira la sesión hasta donde llega el refresh', async () => {
        await llamar(token, { email: 'a@b.c', password: 'buena' })
        const [args] = db.session.updateMany.mock.calls[0]
        const dura = (args.data.expiresAt as Date).getTime() - Date.now()
        expect(dura).toBeGreaterThan((SEGUNDOS_REFRESH - 60) * 1000)
    })

    it('sin identificador, 400', async () => {
        expect((await llamar(token, { password: 'x' })).status).toBe(400)
    })
})

describe('POST /api/auth/refresh', () => {
    it('devuelve un par nuevo', async () => {
        db.refreshToken.findUnique.mockResolvedValue({
            id: 'rt1',
            userId: 'u1',
            sessionId: 's1',
            familyId: 'fam1',
            expiresAt: new Date(Date.now() + 1000 * 60),
            usedAt: null,
            revokedAt: null,
        })
        db.session.findUnique.mockResolvedValue({ revokedAt: null })

        const r = await llamar(refresh, { refresh_token: 'el-que-tengo' })

        expect(r.status).toBe(200)
        expect(decodeJwt(r.body.token).sucursal).toBe('CAM')
    })

    it('inventado, caducado y robado salen con la MISMA cara', async () => {
        // Del otro lado, un 401 significa "la sesión murió: limpia y vuelve a
        // entrar". Distinguirlos en la respuesta sólo le contaría a quien prueba
        // tokens en qué estado están las filas.
        db.refreshToken.findUnique.mockResolvedValue(null)
        const inventado = await llamar(refresh, { refresh_token: 'a' })

        db.refreshToken.findUnique.mockResolvedValue({
            id: 'rt1', userId: 'u1', sessionId: 's1', familyId: 'fam1',
            expiresAt: new Date(Date.now() - 1000), usedAt: null, revokedAt: null,
        })
        const caducado = await llamar(refresh, { refresh_token: 'b' })

        db.refreshToken.findUnique.mockResolvedValue({
            id: 'rt1', userId: 'u1', sessionId: 's1', familyId: 'fam1',
            expiresAt: new Date(Date.now() + 1000),
            // Gastado hace DIEZ MINUTOS, no hace un instante: uno recién gastado
            // es un reintento de red y sale con un par nuevo por la ventana de
            // gracia (`SEGUNDOS_DE_GRACIA`). El robo es el que vuelve tarde.
            usedAt: new Date(Date.now() - 10 * 60 * 1000),
            revokedAt: null,
        })
        const robado = await llamar(refresh, { refresh_token: 'c' })

        expect(inventado).toEqual({ status: 401, body: { error: 'invalid_refresh' } })
        expect(caducado).toEqual(inventado)
        expect(robado).toEqual(inventado)
    })

    it('acepta `refresh` además de `refresh_token`', async () => {
        db.refreshToken.findUnique.mockResolvedValue(null)
        expect((await llamar(refresh, { refresh: 'a' })).status).toBe(401)
    })

    it('si el limitador no contesta, se sigue adelante', async () => {
        // Aquí la protección de verdad es el propio token. Cortar por una caída de
        // Redis sería un 401 con forma de "sesión muerta" en plena calle.
        limitador.rateLimit.mockRejectedValue(new Error('redis caído'))
        db.refreshToken.findUnique.mockResolvedValue({
            id: 'rt1', userId: 'u1', sessionId: 's1', familyId: 'fam1',
            expiresAt: new Date(Date.now() + 60000), usedAt: null, revokedAt: null,
        })
        db.session.findUnique.mockResolvedValue({ revokedAt: null })

        expect((await llamar(refresh, { refresh_token: 'a' })).status).toBe(200)
    })

    it('sin refresh, 400', async () => {
        expect((await llamar(refresh, {})).status).toBe(400)
    })
})

describe('POST /api/auth/logout', () => {
    it('cierra la cadena de ese aparato', async () => {
        db.refreshToken.findUnique.mockResolvedValue({ id: 'rt1', userId: 'u1', familyId: 'fam1' })
        db.refreshToken.findFirst.mockResolvedValue({ sessionId: 's1' })

        const r = await llamar(logout, { refresh_token: 'el-suyo' })

        expect(r).toEqual({ status: 200, body: { ok: true } })
        expect(db.refreshToken.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { familyId: 'fam1', revokedAt: null } })
        )
    })

    it('un token desconocido también sale con un 200', async () => {
        db.refreshToken.findUnique.mockResolvedValue(null)
        expect(await llamar(logout, { refresh_token: 'inventado' })).toEqual({
            status: 200,
            body: { ok: true },
        })
    })

    it('si falla la base, el aparato se va igual', async () => {
        // El refresh caduca solo. Dejar la sesión abierta en el teléfono porque el
        // servidor tuvo un mal momento es peor que no revocarla al instante.
        db.refreshToken.findUnique.mockRejectedValue(new Error('sin base'))
        expect((await llamar(logout, { refresh_token: 'x' })).status).toBe(200)
    })
})
