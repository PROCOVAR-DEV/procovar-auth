/**
 * «Dispositivos y sesiones»: la lógica pura (filas, tipo, marca de la actual, autorización) y
 * el camino real hasta el aviso — con better-auth DE VERDAD (adaptador en memoria) y los hooks
 * puestos, no con un `ctx` inventado.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { betterAuth } from 'better-auth'
import { memoryAdapter } from 'better-auth/adapters/memory'
import { createTranslator } from 'use-intl/core'
import es from '../../../messages/es.json'
import en from '../../../messages/en.json'

const eventos = vi.hoisted(() => ({ publicarSesionCerrada: vi.fn(async () => {}) }))
vi.mock('@/lib/eventos-de-sesion', () => eventos)
// El hook mira si la sesión tiene refresh ligado: aquí, las sesiones cuyo id esté en `refrescos`.
const refrescos = vi.hoisted(() => new Set<string>())
vi.mock('@/lib/prisma', () => ({
    prisma: {
        // el hook `session.create.before` de `auth.ts` mira `activo` (cuentas de baja): aquí, todas activas
        user: { findUnique: vi.fn(async () => ({ activo: true })) },
        refreshToken: { findFirst: vi.fn(async (a: { where: { sessionId: string } }) => (refrescos.has(a.where.sessionId) ? { id: 'r' } : null)) },
    },
}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/historial-de-inicios', () => ({ auditarInicioWeb: vi.fn(async () => {}) }))

import { cerrarSesionesAntes, cerrarSesionesDespues } from '@/lib/hooks-de-sesion'
import {
    CLIENTE_DE_APARATOS,
    autorizarRevocar,
    estaActiva,
    filasDeSesiones,
    hayOtras,
    nombreDeFila,
    revocar,
    salirDeLaWeb,
    textosDelBoton,
    tipoDeSesion,
    type CaminosDeRevocacion,
    type FilaDeSesion,
    type SesionDeBD,
    type Traductor,
} from '@/lib/sesiones-de-la-persona'

const AHORA = new Date('2026-10-08T12:00:00Z')
const min = (n: number) => new Date(AHORA.getTime() + n * 60_000)

const UA_CHROME = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function sesion(o: Partial<SesionDeBD> & { id: string }): SesionDeBD {
    return {
        userId: 'ana',
        clientId: null,
        ipAddress: '10.0.0.1',
        userAgent: UA_CHROME,
        createdAt: min(-600),
        updatedAt: min(-60),
        expiresAt: min(60 * 24),
        revokedAt: null,
        ...o,
    }
}

describe('tipoDeSesion: navegador o dispositivo de Reparto', () => {
    it('con refresh ligado es un dispositivo, aunque su agente parezca un navegador', () => {
        expect(tipoDeSesion({ conRefresh: true })).toBe('aparato')
    })
    it('sin refresh es un navegador: el clientId no cuenta (la cookie qb.flow_state se puede falsificar)', () => {
        expect(tipoDeSesion({ conRefresh: false })).toBe('navegador')
        // aunque alguien le pase el clientId de las APK
        expect(tipoDeSesion({ conRefresh: false, clientId: CLIENTE_DE_APARATOS } as never)).toBe('navegador')
    })
    it('el valor no se separa del de apk-tokens.ts', () => {
        const fuente = readFileSync(path.join(process.cwd(), 'src/lib/apk-tokens.ts'), 'utf8')
        expect(fuente).toContain(`CLIENTE_POR_DEFECTO = '${CLIENTE_DE_APARATOS}'`)
    })
})

describe('filasDeSesiones', () => {
    const base = { userId: 'ana', ahora: AHORA, renovaciones: new Map<string, Date>() }

    it('sólo las sesiones de ESTA persona: nunca las de otra, aunque lleguen mezcladas', () => {
        const filas = filasDeSesiones([sesion({ id: 'a1' }), sesion({ id: 'b1', userId: 'beto' })], {
            ...base,
            sesionActualId: 'a1',
        })
        expect(filas.map((f) => f.id)).toEqual(['a1'])
    })

    it('las revocadas y las caducadas no salen (ni cuentan)', () => {
        const filas = filasDeSesiones(
            [
                sesion({ id: 'viva' }),
                sesion({ id: 'revocada', revokedAt: min(-5) }),
                sesion({ id: 'caducada', expiresAt: min(-1) }),
            ],
            { ...base, sesionActualId: 'viva' },
        )
        expect(filas.map((f) => f.id)).toEqual(['viva'])
        expect(estaActiva(sesion({ id: 'x', expiresAt: AHORA }), AHORA)).toBe(false)
    })

    it('marca la actual (por el id de la sesión del servidor) y la pone la primera, luego por actividad', () => {
        const filas = filasDeSesiones(
            [
                sesion({ id: 'vieja', updatedAt: min(-300) }),
                sesion({ id: 'actual', updatedAt: min(-200) }),
                sesion({ id: 'reciente', updatedAt: min(-10) }),
            ],
            { ...base, sesionActualId: 'actual' },
        )
        expect(filas.map((f) => f.id)).toEqual(['actual', 'reciente', 'vieja'])
        expect(filas.map((f) => f.actual)).toEqual([true, false, false])
    })

    it('sin sesión actual conocida no se marca ninguna', () => {
        const filas = filasDeSesiones([sesion({ id: 'a1' })], { ...base, sesionActualId: null })
        expect(filas.some((f) => f.actual)).toBe(false)
    })

    it('distingue navegador de dispositivo y lee el nombre del agente', () => {
        const renovada = min(-2)
        const filas = filasDeSesiones(
            [
                sesion({ id: 'web' }),
                sesion({ id: 'apk', clientId: CLIENTE_DE_APARATOS, userAgent: 'Dart/3.5 (dart:io)' }),
            ],
            { ...base, sesionActualId: 'web', renovaciones: new Map([['apk', renovada]]) },
        )
        const web = filas.find((f) => f.id === 'web')!
        const apk = filas.find((f) => f.id === 'apk')!
        expect(web).toMatchObject({ tipo: 'navegador', navegador: 'Chrome', sistema: 'Linux', ip: '10.0.0.1' })
        expect(apk).toMatchObject({ tipo: 'aparato', navegador: null, sistema: null })
        // La última actividad de un aparato es su última renovación, no la fila de la sesión.
        expect(apk.ultimaActividad).toBe(renovada.toISOString())
    })

    it('una sesión WEB con clientId «delivery-apk» (cookie falsa) y SIN refresh sale como NAVEGADOR', () => {
        const [f] = filasDeSesiones([sesion({ id: 'falsa', clientId: CLIENTE_DE_APARATOS })], { ...base, sesionActualId: null })
        expect(f.tipo).toBe('navegador')
    })

    it('la IP vacía es «sin IP», y la fila no lleva token', () => {
        const [f] = filasDeSesiones([{ ...sesion({ id: 'a1', ipAddress: '  ' }), token: 'SECRETO' } as SesionDeBD], {
            ...base,
            sesionActualId: 'a1',
        })
        expect(f.ip).toBeNull()
        expect(JSON.stringify(f)).not.toContain('SECRETO')
    })
})

describe('autorizarRevocar: sólo lo propio', () => {
    const propia = { ...sesion({ id: 'p1' }), token: 'tok-p1', conRefresh: false }

    it('una sesión de OTRA persona sale como «no existe» (404), sin confirmar que existe', () => {
        const r = autorizarRevocar('ana', { ...propia, userId: 'beto' }, 'actual', AHORA)
        expect(r).toEqual({ ok: false, estado: 404, error: 'no_encontrada' })
    })
    it('una inexistente o ya revocada, igual', () => {
        expect(autorizarRevocar('ana', null, 'actual', AHORA)).toMatchObject({ ok: false, estado: 404 })
        expect(autorizarRevocar('ana', { ...propia, revokedAt: min(-1) }, 'actual', AHORA)).toMatchObject({ ok: false, estado: 404 })
    })
    it('la actual no se revoca por aquí: es salir (409)', () => {
        expect(autorizarRevocar('ana', propia, 'p1', AHORA)).toMatchObject({ ok: false, estado: 409, error: 'es_la_actual' })
    })
    it('una propia: navegador por better-auth, dispositivo por su familia', () => {
        expect(autorizarRevocar('ana', propia, 'actual', AHORA)).toEqual({ ok: true, via: 'navegador', token: 'tok-p1' })
        expect(autorizarRevocar('ana', { ...propia, conRefresh: true }, 'actual', AHORA)).toMatchObject({ ok: true, via: 'aparato' })
    })
})

function caminosFalsos(): CaminosDeRevocacion & Record<string, ReturnType<typeof vi.fn>> {
    return {
        revokeSession: vi.fn(async () => ({})),
        revokeOtherSessions: vi.fn(async () => ({})),
        revokeSessions: vi.fn(async () => ({})),
        cerrarAparato: vi.fn(async () => true),
    } as never
}

describe('revocar con caminos de mentira', () => {
    const headers = new Headers()
    const actor = { userId: 'ana', sesionId: 'actual' }
    const buscaEn = (filas: Record<string, SesionDeBD & { token: string; conRefresh: boolean }>) => async (id: string) => filas[id] ?? null

    it('una persona NO puede revocar la sesión de otra: 404 y ningún camino se toca', async () => {
        const api = caminosFalsos()
        const ajena = { ...sesion({ id: 'b1', userId: 'beto' }), token: 'tok-b1', conRefresh: false }
        const ajenaAparato = { ...sesion({ id: 'b2', userId: 'beto' }), token: 'tok-b2', conRefresh: true }
        for (const id of ['b1', 'b2']) {
            const r = await revocar(api, headers, actor, { accion: 'una', id }, buscaEn({ b1: ajena, b2: ajenaAparato }), AHORA)
            expect(r).toMatchObject({ ok: false, estado: 404 })
        }
        for (const f of Object.values(api)) expect(f).not.toHaveBeenCalled()
    })

    it('un navegador propio va por revokeSession con SU token; un dispositivo, por su familia', async () => {
        const api = caminosFalsos()
        const web = { ...sesion({ id: 'w1' }), token: 'tok-w1', conRefresh: false }
        const apk = { ...sesion({ id: 'd1' }), token: 'tok-d1', conRefresh: true }
        const buscar = buscaEn({ w1: web, d1: apk })
        await revocar(api, headers, actor, { accion: 'una', id: 'w1' }, buscar, AHORA)
        expect(api.revokeSession).toHaveBeenCalledWith({ headers, body: { token: 'tok-w1' } })
        expect(api.cerrarAparato).not.toHaveBeenCalled()
        await revocar(api, headers, actor, { accion: 'una', id: 'd1' }, buscar, AHORA)
        expect(api.cerrarAparato).toHaveBeenCalledWith('d1')
        expect(api.revokeSession).toHaveBeenCalledTimes(1) // el aparato NO pasó por better-auth
    })

    it('un dispositivo sin familia que cerrar (cerrarAparato → false): se cierra por better-auth, que BORRA la sesión', async () => {
        const api = caminosFalsos()
        vi.mocked(api.cerrarAparato).mockResolvedValue(false)
        const apk = { ...sesion({ id: 'd1' }), token: 'tok-d1', conRefresh: true }
        const r = await revocar(api, headers, actor, { accion: 'una', id: 'd1' }, buscaEn({ d1: apk }), AHORA)
        expect(r).toEqual({ ok: true })
        expect(api.revokeSession).toHaveBeenCalledWith({ headers, body: { token: 'tok-d1' } })
    })

    it('«las demás» y «todas» van por sus caminos de better-auth', async () => {
        const api = caminosFalsos()
        await revocar(api, headers, actor, { accion: 'otras' }, async () => null, AHORA)
        expect(api.revokeOtherSessions).toHaveBeenCalledOnce()
        await revocar(api, headers, actor, { accion: 'todas' }, async () => null, AHORA)
        expect(api.revokeSessions).toHaveBeenCalledOnce()
    })
})

/** better-auth DE VERDAD con los hooks de Accesos y la tabla a la vista. */
function mundo() {
    const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
    const auth = betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        session: { additionalFields: { clientId: { type: 'string', required: false } } },
        hooks: { before: cerrarSesionesAntes, after: cerrarSesionesDespues },
    })
    const cookieDe = (h: Headers) => (h.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
    async function alta(email: string) {
        const r = await auth.api.signUpEmail({
            body: { email, password: 'una-clave-larga-123', name: email },
            returnHeaders: true,
        })
        return { userId: r.response.user.id, cookie: cookieDe(r.headers), token: r.response.token as string }
    }
    /** `aparato`: lo que hace `/api/auth/token` — su clientId Y un refresh ligado a la sesión. */
    async function otraSesion(email: string, aparato = false) {
        const r = await auth.api.signInEmail({ body: { email, password: 'una-clave-larga-123' }, returnHeaders: true })
        const fila = db.session.find((s) => s.token === r.response.token)!
        if (aparato) {
            fila.clientId = CLIENTE_DE_APARATOS
            refrescos.add(fila.id as string)
        }
        return { cookie: cookieDe(r.headers), id: fila.id as string }
    }
    const buscar = async (id: string) => {
        const f = db.session.find((s) => s.id === id)
        return f ? ({ ...f, conRefresh: refrescos.has(id) } as never) : null
    }
    return { auth, db, alta, otraSesion, buscar }
}

describe('el camino real hasta el aviso (better-auth + hooks)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        refrescos.clear()
    })

    function api(auth: ReturnType<typeof mundo>['auth']) {
        return {
            revokeSession: (a: never) => auth.api.revokeSession(a),
            revokeOtherSessions: (a: never) => auth.api.revokeOtherSessions(a),
            revokeSessions: (a: never) => auth.api.revokeSessions(a),
            cerrarAparato: vi.fn(async () => true),
        } as unknown as CaminosDeRevocacion & { cerrarAparato: ReturnType<typeof vi.fn> }
    }

    it('«cerrar en todos los dispositivos» publica «revocada» (alcance todo) y vacía las sesiones de ESA persona', async () => {
        const m = mundo()
        const ana = await m.alta('ana@procovar.local')
        const beto = await m.alta('beto@procovar.local')
        await m.otraSesion('ana@procovar.local', true)
        const r = await revocar(api(m.auth), new Headers({ cookie: ana.cookie }), { userId: ana.userId, sesionId: null }, { accion: 'todas' }, m.buscar)
        expect(r).toEqual({ ok: true })
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce()
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([ana.userId], 'revocada')
        expect(m.db.session.filter((s) => s.userId === ana.userId)).toHaveLength(0)
        expect(m.db.session.filter((s) => s.userId === beto.userId)).toHaveLength(1) // la de Beto, intacta
    })

    it('«las demás» publica «revocada» y deja la actual', async () => {
        const m = mundo()
        const ana = await m.alta('ana@procovar.local')
        await m.otraSesion('ana@procovar.local')
        await revocar(api(m.auth), new Headers({ cookie: ana.cookie }), { userId: ana.userId, sesionId: null }, { accion: 'otras' }, m.buscar)
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([ana.userId], 'revocada')
        expect(m.db.session.map((s) => s.token)).toEqual([ana.token])
    })

    it('cerrar UN navegador publica alcance web («logout»), y sólo esa sesión desaparece', async () => {
        const m = mundo()
        const ana = await m.alta('ana@procovar.local')
        const otra = await m.otraSesion('ana@procovar.local')
        const r = await revocar(api(m.auth), new Headers({ cookie: ana.cookie }), { userId: ana.userId, sesionId: 'la-actual' }, { accion: 'una', id: otra.id }, m.buscar)
        expect(r).toEqual({ ok: true })
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce()
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([ana.userId], 'logout')
        expect(m.db.session.some((s) => s.id === otra.id)).toBe(false)
        expect(m.db.session.some((s) => s.token === ana.token)).toBe(true)
    })

    it('cerrar UN dispositivo no publica nada y no pasa por better-auth', async () => {
        const m = mundo()
        const ana = await m.alta('ana@procovar.local')
        const apk = await m.otraSesion('ana@procovar.local', true)
        const caminos = api(m.auth)
        await revocar(caminos, new Headers({ cookie: ana.cookie }), { userId: ana.userId, sesionId: 'la-actual' }, { accion: 'una', id: apk.id }, m.buscar)
        expect(caminos.cerrarAparato).toHaveBeenCalledWith(apk.id)
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
    })

    it('Ana NO puede cerrar la sesión de Beto: 404, la de Beto sigue y no sale ningún aviso', async () => {
        const m = mundo()
        const ana = await m.alta('ana@procovar.local')
        const beto = await m.alta('beto@procovar.local')
        const deBeto = m.db.session.find((s) => s.userId === beto.userId)!
        const r = await revocar(api(m.auth), new Headers({ cookie: ana.cookie }), { userId: ana.userId, sesionId: 'la-actual' }, { accion: 'una', id: deBeto.id as string }, m.buscar)
        expect(r).toMatchObject({ ok: false, estado: 404 })
        expect(m.db.session.some((s) => s.id === deBeto.id)).toBe(true)
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
    })
})

/**
 * La cookie `qb.flow_state` va SIN FIRMAR: quien entra por la web con credenciales puede poner en ella
 * `{"clientId":"delivery-apk"}`. Con better-auth DE VERDAD y la configuración REAL de `lib/auth.ts`
 * (sus `databaseHooks`, su `session`, sus `hooks`): esa sesión es un NAVEGADOR, «Cerrar» la borra de
 * verdad y avisa con alcance web. `cerrarAparato` no se simula: si se llamara, la prueba falla.
 */
describe('cookie de flujo falsa con el clientId de los aparatos (flujo real)', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        refrescos.clear()
    })
    const flujo = (clientId: string) => 'qb.flow_state=' + encodeURIComponent(JSON.stringify({ clientId }))

    async function mundoReal() {
        const { auth: real } = await import('@/lib/auth')
        const db: Record<string, Record<string, unknown>[]> = { user: [], session: [], account: [], verification: [] }
        const auth = betterAuth({
            baseURL: 'http://localhost:3500',
            secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
            database: memoryAdapter(db),
            emailAndPassword: { enabled: true },
            session: real.options.session,
            databaseHooks: real.options.databaseHooks,
            hooks: real.options.hooks,
        })
        return { auth, db }
    }

    it('sale como NAVEGADOR, «Cerrar» la borra de verdad y publica «logout» (web)', async () => {
        const { auth, db } = await mundoReal()
        const r = await auth.api.signUpEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' }, returnHeaders: true })
        const cookieAna = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
        const userId = r.response.user.id
        // el atacante entra con las credenciales y la cookie falsa
        await auth.api.signInEmail({
            body: { email: 'a@procovar.local', password: 'una-clave-larga-123' },
            headers: new Headers({ cookie: flujo(CLIENTE_DE_APARATOS), 'user-agent': UA_CHROME }),
        })
        const falsa = db.session.find((s) => s.userAgent === UA_CHROME)!
        expect(falsa.clientId ?? null).toBeNull() // la cookie NO escribió el clientId de los aparatos

        const filas = filasDeSesiones(db.session.map((s) => ({ ...s, revokedAt: null }) as unknown as SesionDeBD), {
            userId, sesionActualId: null, renovaciones: new Map(), ahora: new Date(),
        })
        expect(filas.find((f) => f.id === falsa.id)!.tipo).toBe('navegador')

        const cerrarAparato = vi.fn(async () => { throw new Error('un navegador no pasa por cerrarAparato') })
        const caminos = {
            revokeSession: (a: never) => auth.api.revokeSession(a),
            revokeOtherSessions: (a: never) => auth.api.revokeOtherSessions(a),
            revokeSessions: (a: never) => auth.api.revokeSessions(a),
            cerrarAparato,
        } as unknown as CaminosDeRevocacion
        const buscar = async (id: string) => {
            const f = db.session.find((x) => x.id === id)
            return f ? ({ ...f, conRefresh: refrescos.has(id) } as never) : null
        }
        const res = await revocar(caminos, new Headers({ cookie: cookieAna }), { userId, sesionId: 'la-actual' }, { accion: 'una', id: falsa.id as string }, buscar)
        expect(res).toEqual({ ok: true })
        expect(cerrarAparato).not.toHaveBeenCalled()
        expect(db.session.some((s) => s.id === falsa.id)).toBe(false) // BORRADA, no «revocada»
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledOnce()
        expect(eventos.publicarSesionCerrada).toHaveBeenCalledWith([userId], 'logout')
    })

    it('un flujo legítimo (otra aplicación) sigue escribiendo su clientId', async () => {
        const { auth, db } = await mundoReal()
        await auth.api.signUpEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' } })
        await auth.api.signInEmail({
            body: { email: 'a@procovar.local', password: 'una-clave-larga-123' },
            headers: new Headers({ cookie: flujo('pedido') }),
        })
        expect(db.session.some((s) => s.clientId === 'pedido')).toBe(true)
    })

    it('una sesión de APK de verdad (refresh ligado) SIGUE siendo un aparato, y cerrarla no publica', async () => {
        const { auth, db } = await mundoReal()
        const r = await auth.api.signUpEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' }, returnHeaders: true })
        const cookieAna = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
        const userId = r.response.user.id
        // lo que hace /api/auth/token: sesión por signIn (sin cookie de flujo), refresh ligado y clientId puesto después
        const e = await auth.api.signInEmail({ body: { email: 'a@procovar.local', password: 'una-clave-larga-123' } })
        const apk = db.session.find((s) => s.token === e.token)!
        apk.clientId = CLIENTE_DE_APARATOS
        refrescos.add(apk.id as string)
        const [f] = filasDeSesiones([{ ...apk, revokedAt: null } as unknown as SesionDeBD], {
            userId, sesionActualId: null, renovaciones: new Map([[apk.id as string, new Date()]]), ahora: new Date(),
        })
        expect(f.tipo).toBe('aparato')
        // aunque se cerrara por better-auth (el respaldo), el hook lo clasifica por el refresh: sin aviso
        await auth.api.revokeSession({ headers: new Headers({ cookie: cookieAna }), body: { token: apk.token as string } })
        expect(eventos.publicarSesionCerrada).not.toHaveBeenCalled()
    })
})

describe('lógica de la pantalla, EJECUTADA (hayOtras, textos del botón, salir)', () => {
    const fila = (o: Partial<FilaDeSesion>): FilaDeSesion => ({
        id: 'x', tipo: 'navegador', navegador: 'Chrome', sistema: 'Linux', ip: null, entroEl: '', ultimaActividad: '', actual: false, ...o,
    })

    it('hayOtras: sólo la actual → no; con otra → sí; vacía → no', () => {
        expect(hayOtras([])).toBe(false)
        expect(hayOtras([fila({ actual: true })])).toBe(false)
        expect(hayOtras([fila({ actual: true }), fila({ id: 'y' })])).toBe(true)
    })

    for (const [lengua, mensajes] of [['es', es], ['en', en]] as const) {
        const t = createTranslator({ locale: lengua, messages: mensajes, namespace: 'dispositivos' }) as unknown as Traductor
        it(`[${lengua}] el nombre accesible del botón CONTIENE el texto visible y el nombre de la sesión (WCAG 2.5.3)`, () => {
            for (const f of [fila({}), fila({ tipo: 'aparato', navegador: null, sistema: null }), fila({ tipo: 'aparato', navegador: null, sistema: 'Android' }), fila({ navegador: null, sistema: null })]) {
                const { visible, aria } = textosDelBoton(f, t)
                expect(visible.length).toBeGreaterThan(0)
                expect(aria).toContain(visible)
                expect(aria).toContain(nombreDeFila(f, t))
            }
        })
        it(`[${lengua}] nombres: aparato → App de Reparto (con sistema si lo hay); navegador → «Chrome en Linux»; sin datos → sin identificar`, () => {
            expect(nombreDeFila(fila({ tipo: 'aparato', navegador: null, sistema: null }), t)).toBe(t('app'))
            expect(nombreDeFila(fila({ tipo: 'aparato', navegador: null, sistema: 'Android' }), t)).toContain('Android')
            expect(nombreDeFila(fila({}), t)).toBe(t('nombre', { navegador: 'Chrome', sistema: 'Linux' }))
            expect(nombreDeFila(fila({ navegador: null, sistema: null }), t)).toBe(t('sinNombre'))
        })
    }

    it('salirDeLaWeb: sólo va a la entrada si signOut NO devolvió error', async () => {
        const ir = vi.fn()
        expect(await salirDeLaWeb(async () => ({ error: { status: 500 } }), ir)).toBe(false)
        expect(await salirDeLaWeb(async () => { throw new Error('sin red') }, ir)).toBe(false)
        expect(ir).not.toHaveBeenCalled()
        expect(await salirDeLaWeb(async () => ({ error: null }), ir)).toBe(true)
        expect(ir).toHaveBeenCalledOnce()
    })
})
