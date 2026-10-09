/**
 * `POST /api/auth/entrega` — el token de ENTREGA (paquete A1 de la bandeja de revisión).
 *
 * Diseño: `delivery-logistica/docs/bandeja-de-revision.md` (B.1 y A.4.1). Quien conserva sesión viva
 * pero ya no tiene `delivery.entrar` recibe un token de 10 minutos, de un solo ámbito, sin roles ni
 * llaves, con el que sólo se puede dejar su trabajo en la bandeja de revisión.
 *
 * Lo que de verdad importa aquí es lo que NO se firma: una sesión revocada, una baja, un refresh
 * gastado, o quien SÍ tiene la llave. Cada una de esas negativas tiene su prueba, y el ORDEN (sesión,
 * persona y refresh antes de mirar la llave) se ata con el número de consultas que se llegan a hacer.
 *
 * `emitirEntrega` va de verdad, sobre filas en memoria; sólo Prisma, el limitador, la auditoría y el
 * registro son dobles.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { jwtVerify } from 'jose'

vi.hoisted(() => {
    process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
    process.env.APP_URL = 'https://auth.example.com'
})

const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: { create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    session: { findUnique: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { OPTIONS, POST as entrega } from '../entrega/route'
import { AMBITO_ENTREGA, PROPOSITO_ENTREGA, SEGUNDOS_ENTREGA, SEGUNDOS_REFRESH } from '@/lib/apk-tokens'
import { audit } from '@/lib/audit'
import { rateLimit } from '@/lib/rate-limit'

const REFRESH = 'el-refresh-de-la-apk'
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const SECRETO = new TextEncoder().encode(process.env.JWT_SECRET!)

/** La persona tal y como la leen `resolverIdentidad` (la consulta falsa sirve para las dos lecturas). */
const persona = (llaves: string[], extra: Record<string, unknown> = {}) => ({
    id: 'u1',
    name: 'Yasmani',
    email: 'y@procovar.local',
    username: 'yasmani',
    activo: true,
    isSystemAdmin: false,
    defaultRole: { name: 'OPERADOR', permissions: llaves.map((key) => ({ permission: { key } })) },
    members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [{ role: { name: 'OPERADOR', permissions: [] } }] }],
    ...extra,
})

/** Una fila de refresh en memoria. Esta ruta no escribe nada: se devuelve tal cual, y se mira que no cambie. */
function filaDeRefresh(extra: Record<string, unknown> = {}) {
    const estado: Record<string, unknown> = {
        id: 'rt1',
        userId: 'u1',
        sessionId: 's1',
        familyId: 'fam1',
        clientId: 'delivery-apk',
        expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000),
        usedAt: null,
        revokedAt: null,
        graceUsedAt: null,
        ...extra,
    }
    db.refreshToken.findUnique.mockImplementation((async ({ where }: never) =>
        (where as { tokenHash?: string }).tokenHash === sha256(REFRESH) ? { ...estado } : null) as never)
    return estado
}

const viva = () => ({ revokedAt: null, expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000) })

const pedir = async (cuerpo: unknown = { refresh_token: REFRESH }, cabeceras: Record<string, string> = {}) => {
    const res = await entrega({
        headers: new Headers({ 'user-agent': 'reparto/1.0', 'x-real-ip': '10.1.2.3', ...cabeceras }),
        json: async () => cuerpo,
    } as never)
    return { status: res.status, body: await res.json(), res }
}

const acciones = () => vi.mocked(audit).mock.calls.map((c) => c[0].action)
const denegadaCon = (motivo: string) =>
    expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.apk.entrega_denegada', userId: 'u1', meta: expect.objectContaining({ motivo }) }),
    )
/** Nada de lo que escribe una renovación puede haberse llamado: la entrega sólo lee. */
const nadaEscrito = () => {
    expect(db.refreshToken.create).not.toHaveBeenCalled()
    expect(db.refreshToken.update).not.toHaveBeenCalled()
    expect(db.refreshToken.updateMany).not.toHaveBeenCalled()
    expect(db.session.updateMany).not.toHaveBeenCalled()
    expect(db.session.deleteMany).not.toHaveBeenCalled()
}

beforeEach(() => {
    vi.resetAllMocks()
    vi.mocked(rateLimit).mockResolvedValue({ allowed: true, remaining: 10 })
    db.session.findUnique.mockResolvedValue(viva())
    // La persona de casi todas las pruebas: sesión viva y SIN `delivery.entrar` (sí otra llave, a propósito).
    db.user.findUnique.mockResolvedValue(persona(['pedido.entrar']))
})

describe('el caso bueno: sesión viva, sin delivery.entrar', () => {
    it('200 con un token de entrega, y el cuerpo NO lleva refresh', async () => {
        filaDeRefresh()
        const r = await pedir()

        expect(r.status).toBe(200)
        expect(Object.keys(r.body).sort()).toEqual(['ambito', 'expires_in', 'token', 'token_type'])
        expect(r.body.token_type).toBe('Bearer')
        expect(r.body.expires_in).toBe(600)
        expect(r.body.ambito).toBe('reparto.entrega')
        expect(r.body.refresh_token).toBeUndefined()
        expect(r.body.refresh_expires_in).toBeUndefined()
        expect(JSON.stringify(r.body)).not.toContain(REFRESH)
    })

    it('los claims son EXACTAMENTE los del contrato, firmados HS256 con JWT_SECRET', async () => {
        filaDeRefresh()
        const { body } = await pedir()
        const { payload, protectedHeader } = await jwtVerify(body.token, SECRETO, { algorithms: ['HS256'] })

        expect(protectedHeader.alg).toBe('HS256')
        expect(payload.purpose).toBe('apk:entrega')
        expect(payload.purpose).toBe(PROPOSITO_ENTREGA)
        expect(payload.ambito).toBe('reparto.entrega')
        expect(payload.ambito).toBe(AMBITO_ENTREGA)
        expect(payload.sub).toBe('u1')
        expect(payload.name).toBe('Yasmani')
        expect(payload.email).toBe('y@procovar.local')
        expect(payload.sid).toBe('s1')
        expect(payload.sucursal).toBe('CAM')
        expect(payload.branch_id).toBe('CAM')
        expect(typeof payload.jti).toBe('string')
        // Todos los claims, ni uno más ni uno menos. `iatms` va como en el acceso (marcas de invalidación en ms).
        expect(Object.keys(payload).sort()).toEqual(
            ['ambito', 'branch_id', 'email', 'entradas', 'exp', 'iat', 'iatms', 'iss', 'jti', 'name', 'purpose', 'role', 'roles', 'sid', 'sub', 'sucursal'].sort(),
        )
    })

    it('SIN roles y SIN llaves, aunque la persona tenga otras: entradas [] y roles []', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar', 'rutas.entrar']))
        const { body } = await pedir()
        const { payload } = await jwtVerify(body.token, SECRETO)

        expect(payload.entradas).toEqual([])
        expect(payload.roles).toEqual([])
        expect(payload.role).toBe('')
        expect(JSON.stringify(payload)).not.toContain('delivery.entrar')
        expect(JSON.stringify(payload)).not.toContain('OPERADOR')
    })

    it('dura 600 s: exp - iat <= 600 (el número, no la constante)', async () => {
        filaDeRefresh()
        const { body } = await pedir()
        const { payload } = await jwtVerify(body.token, SECRETO)

        expect(SEGUNDOS_ENTREGA).toBe(600)
        expect(payload.exp! - payload.iat!).toBe(600)
        expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(600)
    })

    // BAJO-3 (auditoría A1): `iatms` era `Date.now()` de la firma; ha de ser el instante en que se LEYÓ la sesión.
    it('`iatms` es el instante en que se LEYÓ la sesión, no el de firmar (base lenta: la persona tarda 700 ms)', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        try {
            const lectura = 1_790_000_000_900
            vi.setSystemTime(lectura)
            filaDeRefresh({ expiresAt: new Date(lectura + SEGUNDOS_REFRESH * 1000) })
            db.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(lectura + 5 * 24 * 3600 * 1000) })
            db.user.findUnique.mockImplementation((async () => {
                vi.setSystemTime(lectura + 700) // la base tarda
                return persona(['pedido.entrar'])
            }) as never)
            const { body } = await pedir()
            const { payload } = await jwtVerify(body.token, SECRETO, { currentDate: new Date(lectura + 700) })
            expect(payload.iatms).toBe(lectura)
            expect(payload.iat! * 1000).toBeGreaterThan(lectura) // `iat` sí es el de la firma
        } finally {
            vi.useRealTimers()
        }
    })

    it('NO gasta el refresh: la fila queda intacta y no se escribe nada en la base', async () => {
        const fila = filaDeRefresh()
        const r = await pedir()

        expect(r.status).toBe(200)
        expect(fila.usedAt).toBeNull()
        expect(fila.revokedAt).toBeNull()
        nadaEscrito()
        // Y vale otra vez: el mismo refresh entrega de nuevo (un toque más, un token nuevo).
        const otra = await pedir()
        expect(otra.status).toBe(200)
        expect(otra.body.token).not.toBe(r.body.token)
    })

    it('`refresh` vale como alias de `refresh_token`', async () => {
        filaDeRefresh()
        expect((await pedir({ refresh: REFRESH })).status).toBe(200)
    })

    it('queda en la auditoría como auth.apk.entrega, SIN el token ni el refresh', async () => {
        filaDeRefresh()
        const r = await pedir()

        expect(audit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'auth.apk.entrega',
                userId: 'u1',
                clientId: 'delivery-apk',
                ip: '10.1.2.3',
                userAgent: 'reparto/1.0',
                meta: expect.objectContaining({ sessionId: 's1' }),
            }),
        )
        const todo = JSON.stringify(vi.mocked(audit).mock.calls)
        expect(todo).not.toContain(REFRESH)
        expect(todo).not.toContain(r.body.token)
    })
})

describe('quien SÍ tiene delivery.entrar no recibe token: 409', () => {
    it('con la llave: 409 tiene_permiso, sin token', async () => {
        const fila = filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        const r = await pedir()

        expect(r.status).toBe(409)
        expect(r.body).toEqual({ error: 'tiene_permiso', codigo: 'tiene_permiso' })
        expect(r.body.token).toBeUndefined()
        expect(fila.usedAt).toBeNull()
        nadaEscrito()
        denegadaCon('tiene_permiso')
        expect(acciones()).not.toContain('auth.apk.entrega')
    })

    it('el administrador de sistema las tiene todas: 409', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona([], { isSystemAdmin: true }))
        expect((await pedir()).status).toBe(409)
    })

    it('la llave la dan también los roles de las membresías, no sólo el rol por defecto', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(
            persona([], {
                members: [
                    {
                        organization: { codigo: 'CAM', activa: true },
                        memberRoles: [{ role: { name: 'LOGISTICO', permissions: [{ permission: { key: 'delivery.entrar' } }] } }],
                    },
                ],
            }),
        )
        expect((await pedir()).status).toBe(409)
    })
})

describe('quien NO conserva sesión viva no entrega: 401, y SIN mirar la llave', () => {
    it('sesión REVOCADA y sin llave: 401, no 403, sin token, y ni se consulta a la persona', async () => {
        filaDeRefresh()
        db.session.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) })
        const r = await pedir()

        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_refresh' })
        expect(r.body.token).toBeUndefined()
        // El orden: la sesión se mira ANTES que la persona y su llave. Si se consultó, se miró la llave antes.
        expect(db.user.findUnique).not.toHaveBeenCalled()
        nadaEscrito()
        denegadaCon('sesion_revocada')
        expect(acciones()).not.toContain('auth.apk.entrega')
    })

    it('sesión revocada pero CON la llave: 401 (no 409): la sesión manda antes que la llave', async () => {
        filaDeRefresh()
        db.session.findUnique.mockResolvedValue({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) })
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar']))
        expect((await pedir()).status).toBe(401)
    })

    it('sesión que ya no existe, o caducada, o un refresh sin sesión: 401', async () => {
        filaDeRefresh()
        db.session.findUnique.mockResolvedValue(null)
        expect((await pedir()).status).toBe(401)

        db.session.findUnique.mockResolvedValue({ revokedAt: null, expiresAt: new Date(Date.now() - 1000) })
        expect((await pedir()).status).toBe(401)

        filaDeRefresh({ sessionId: null })
        db.session.findUnique.mockResolvedValue(viva())
        expect((await pedir()).status).toBe(401)
        expect(acciones().filter((a) => a === 'auth.apk.entrega')).toEqual([])
    })

    it('BAJA (activo=false) sin la llave: 401, sin token', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar'], { activo: false }))
        const r = await pedir()

        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_refresh' })
        denegadaCon('baja')
        expect(acciones()).not.toContain('auth.apk.entrega')
    })

    it('baja CON la llave: también 401 (no 409)', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['delivery.entrar'], { activo: false }))
        expect((await pedir()).status).toBe(401)
    })

    it('la persona ya no existe: 401', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(null)
        expect((await pedir()).status).toBe(401)
    })

    it('refresh YA GASTADO: 401, NO se revoca la cuenta (no es esta puerta quien castiga robos) y no se mira nada más', async () => {
        const fila = filaDeRefresh({ usedAt: new Date(Date.now() - 5_000) }) // dentro de la gracia: tampoco vale aquí
        const r = await pedir()

        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_refresh' })
        expect(fila.revokedAt).toBeNull()
        nadaEscrito()
        expect(db.session.findUnique).not.toHaveBeenCalled()
        expect(db.user.findUnique).not.toHaveBeenCalled()
        denegadaCon('refresh_gastado')
        expect(acciones()).not.toContain('auth.refresh.reuse')
    })

    it('refresh gastado hace una hora (lo que en /refresh sería un robo): aquí 401 y NADA se revoca', async () => {
        filaDeRefresh({ usedAt: new Date(Date.now() - 3600_000) })
        expect((await pedir()).status).toBe(401)
        nadaEscrito()
    })

    it('refresh revocado, caducado o inventado: 401', async () => {
        filaDeRefresh({ revokedAt: new Date() })
        expect((await pedir()).status).toBe(401)
        denegadaCon('refresh_revocado')

        filaDeRefresh({ expiresAt: new Date(Date.now() - 1000) })
        expect((await pedir()).status).toBe(401)
        denegadaCon('refresh_caducado')

        vi.mocked(audit).mockClear()
        db.refreshToken.findUnique.mockResolvedValue(null)
        const r = await pedir()
        expect(r.status).toBe(401)
        expect(r.body).toEqual({ error: 'invalid_refresh' })
        // Un token que no está en la tabla no dice de quién es: ruido, sin rastro.
        expect(audit).not.toHaveBeenCalled()
        nadaEscrito()
    })

    it('un refresh de OTRA aplicación no produce un token de Reparto', async () => {
        filaDeRefresh({ clientId: 'procovar-rutas' })
        const r = await pedir()
        expect(r.status).toBe(401)
        denegadaCon('otro_cliente')
    })

    it('una fila anterior a la columna `clientId` (null) es delivery-apk, y entrega', async () => {
        filaDeRefresh({ clientId: null })
        expect((await pedir()).status).toBe(200)
    })
})

describe('sin sucursal: 403 con su texto', () => {
    it('entra bien pero no hay alcance que firmar: 403 sin_sucursal, sin token', async () => {
        filaDeRefresh()
        db.user.findUnique.mockResolvedValue(persona(['pedido.entrar'], { members: [] }))
        const r = await pedir()

        expect(r.status).toBe(403)
        expect(r.body.error).toBe('sin_sucursal')
        expect(r.body.message).toEqual(expect.any(String))
        expect(r.body.token).toBeUndefined()
        denegadaCon('sin_sucursal')
    })
})

describe('el límite de tasa', () => {
    it('si el limitador dice que no (por IP o por huella): 429 y no se toca la base', async () => {
        filaDeRefresh()
        vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: false, remaining: 0 }).mockResolvedValueOnce({ allowed: true, remaining: 3 })
        const porIp = await pedir()
        expect(porIp.status).toBe(429)
        expect(porIp.body).toEqual({ error: 'rate_limited' })

        vi.mocked(rateLimit).mockResolvedValueOnce({ allowed: true, remaining: 3 }).mockResolvedValueOnce({ allowed: false, remaining: 0 })
        const porHuella = await pedir()
        expect(porHuella.status).toBe(429)

        expect(db.refreshToken.findUnique).not.toHaveBeenCalled()
        expect(db.session.findUnique).not.toHaveBeenCalled()
        expect(acciones()).not.toContain('auth.apk.entrega')
    })

    it('se limita por IP Y por huella del refresh (nunca el refresh en claro)', async () => {
        filaDeRefresh()
        await pedir()

        const llamadas = vi.mocked(rateLimit).mock.calls.map((c) => c[0])
        expect(llamadas.map((l) => l.scope).sort()).toEqual(['apk-entrega-ip', 'apk-entrega-refresh'])
        expect(llamadas.find((l) => l.scope === 'apk-entrega-ip')!.identifier).toBe('10.1.2.3')
        const huella = llamadas.find((l) => l.scope === 'apk-entrega-refresh')!.identifier
        expect(huella).not.toContain(REFRESH)
        expect(sha256(REFRESH).startsWith(huella)).toBe(true)
    })

    it('si Redis no contesta NO se abre: 503 comprobacion_no_disponible, sin token y sin tocar la base', async () => {
        filaDeRefresh()
        vi.mocked(rateLimit).mockRejectedValue(new Error('redis caído'))
        const r = await pedir()

        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(r.body.token).toBeUndefined()
        expect(db.refreshToken.findUnique).not.toHaveBeenCalled()
        expect(acciones()).not.toContain('auth.apk.entrega')
    })
})

describe('la base caída: 503, nunca 401/403/500', () => {
    it.each([
        ['el refresh', () => db.refreshToken.findUnique.mockRejectedValue(new Error('base caída'))],
        ['la sesión', () => db.session.findUnique.mockRejectedValue(new Error('base caída'))],
        ['la persona', () => db.user.findUnique.mockRejectedValue(new Error('base caída'))],
    ])('al leer %s', async (_n, romper) => {
        filaDeRefresh()
        romper()
        const r = await pedir()

        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'comprobacion_no_disponible' })
        expect(r.body.token).toBeUndefined()
        expect(acciones()).not.toContain('auth.apk.entrega')
    })
})

describe('el cuerpo', () => {
    it('sin JSON: 400 invalid_json; sin refresh: 400 invalid_body', async () => {
        const sinJson = await entrega({ headers: new Headers(), json: async () => { throw new Error('x') } } as never)
        expect(sinJson.status).toBe(400)
        expect(await sinJson.json()).toEqual({ error: 'invalid_json' })

        const r = await pedir({})
        expect(r.status).toBe(400)
        expect(r.body).toEqual({ error: 'invalid_body' })
        expect(db.refreshToken.findUnique).not.toHaveBeenCalled()
    })
})

describe('CORS, como el resto de las puertas de la APK', () => {
    it('el preflight desde Reparto web contesta 204 con POST y la cabecera de origen', async () => {
        const res = await OPTIONS({ headers: new Headers({ origin: 'https://reparto.procovar.cloud' }) } as never)
        expect(res.status).toBe(204)
        expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://reparto.procovar.cloud')
        expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    })

    it('la respuesta lleva Access-Control-Allow-Origin también en el 401 (si no, el navegador lo ve como «sin red»)', async () => {
        db.refreshToken.findUnique.mockResolvedValue(null)
        const r = await pedir({ refresh_token: 'x' }, { origin: 'https://reparto.procovar.cloud' })
        expect(r.status).toBe(401)
        expect(r.res.headers.get('Access-Control-Allow-Origin')).toBe('https://reparto.procovar.cloud')
    })

    it('un origen que no está en la lista no recibe la cabecera', async () => {
        db.refreshToken.findUnique.mockResolvedValue(null)
        const r = await pedir({ refresh_token: 'x' }, { origin: 'https://malo.example.com' })
        expect(r.res.headers.get('Access-Control-Allow-Origin')).toBeNull()
    })
})
