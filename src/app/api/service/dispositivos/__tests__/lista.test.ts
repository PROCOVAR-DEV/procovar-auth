/**
 * `/api/service/dispositivos` (docs/dispositivos.md): lo que las aplicaciones leen para saber qué aparatos tienen.
 *
 * Se ata, sobre todo, LO QUE NO PUEDE PASAR: que el CRM vea un aparato de Reparto. La aplicación sale de los `scopes` de la
 * credencial (`dispositivos:<clientId>`), no de un `?app=`; sin scope, 403; con `?app=` ajeno, 403; el comodín `*` no vale.
 * Además: que el tope AVISA, que el cursor no salta ni repite filas que comparten hora, y que la importación es idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
    dispositivo: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/with-service-auth', () => ({ withServiceAuth: (h: unknown) => h }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { GET, POST } from '../route'
import {
    appDeLaPeticion, appsPermitidas, clienteDeApp, codificarCursor, decodificarCursor, limiteDe, LIMITE_MAXIMO,
} from '@/lib/dispositivos-lista'

type Manejador = (r: Request, ctx: unknown) => Promise<Response>
const ctxCon = (...scopes: string[]) => ({ client: { clientId: 'crm-servicio', keyVersion: 1, scopes, name: 'CRM' } })
const CRM = ctxCon('dispositivos:crm-apk')

const get = (query: string, ctx = CRM) => (GET as unknown as Manejador)(new Request(`http://x/api/service/dispositivos${query}`), ctx)
const post = (cuerpo: unknown, ctx = CRM, query = '') =>
    (POST as unknown as Manejador)(
        new Request(`http://x/api/service/dispositivos${query}`, { method: 'POST', body: typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo) }),
        ctx,
    )

const fila = (n: number, extra: Record<string, unknown> = {}) => ({
    id: `d${n}`, aparatoId: `0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c${String(n).padStart(2, '0')}`, userId: 'u1', clientId: 'crm-apk',
    sucursal: 'STG', plataforma: 'Android', version: '2.3.1', equipo: 'Samsung A14', nombre: null,
    primeraVez: new Date('2026-10-20T10:00:00Z'), vistoAt: new Date('2026-10-29T12:00:00Z'),
    updatedAt: new Date(`2026-10-29T12:00:0${n}Z`), bloqueadoAt: null, ...extra,
})

beforeEach(() => vi.resetAllMocks())

describe('QUÉ APLICACIÓN VE QUIÉN: sale de la credencial, no de lo que mande', () => {
    it('solo cuentan los scopes `dispositivos:<app>`; el comodín y los demás no', () => {
        expect(appsPermitidas(['dispositivos:crm-apk', 'callback:create', '*'])).toEqual(['crm-apk'])
        expect(appsPermitidas(['*'])).toEqual([])
        expect(appsPermitidas(['dispositivos:'])).toEqual([])
        expect(appsPermitidas(['dispositivos:../x'])).toEqual([])
    })

    it('el CRM con `?app=reparto` es 403 (no una lista vacía) y no toca la base', async () => {
        for (const q of ['?app=reparto', '?app=delivery-apk', '?app=delivery']) {
            const r = await get(q)
            expect(r.status).toBe(403)
            expect((await r.json()).error).toBe('app_no_permitida')
        }
        expect(db.dispositivo.findMany).not.toHaveBeenCalled()
    })

    it('sin el scope de dispositivos (o con solo el comodín) es 403', async () => {
        expect((await get('?app=crm', ctxCon('callback:create'))).status).toBe(403)
        expect((await get('?app=crm', ctxCon('*'))).status).toBe(403)
        expect((await get('', ctxCon())).status).toBe(403)
        expect(db.dispositivo.findMany).not.toHaveBeenCalled()
    })

    it('sin `?app=` y con UNA sola app permitida, es esa; con varias, hay que decirla', async () => {
        db.dispositivo.findMany.mockResolvedValue([])
        expect((await get('')).status).toBe(200)
        expect(db.dispositivo.findMany.mock.calls[0][0].where.AND).toContainEqual({ clientId: 'crm-apk' })
        expect((await get('', ctxCon('dispositivos:crm-apk', 'dispositivos:delivery-apk'))).status).toBe(400)
    })

    it('el CRM nunca recibe una fila de otra app: el filtro por app va SIEMPRE', async () => {
        db.dispositivo.findMany.mockResolvedValue([])
        await get('?app=crm')
        await get('?app=crm-apk')
        for (const llamada of db.dispositivo.findMany.mock.calls) {
            expect(llamada[0].where.AND).toContainEqual({ clientId: 'crm-apk' })
        }
    })

    it('`reparto` es `delivery-apk`; una app rara es 400', () => {
        expect(clienteDeApp('Reparto')).toBe('delivery-apk')
        expect(appDeLaPeticion('../x', ['crm-apk'])).toEqual({ ok: false, estado: 400, error: 'app_invalida' })
    })
})

describe('la respuesta', () => {
    it('da el estado, el nombre (el de un administrador manda sobre el del aparato) y filtra por sucursal', async () => {
        db.dispositivo.findMany.mockResolvedValue([fila(1), fila(2, { bloqueadoAt: new Date(), nombre: 'PC de Palma' })])
        const r = await get('?sucursal=stg')
        const cuerpo = await r.json()
        expect(db.dispositivo.findMany.mock.calls[0][0].where.AND).toContainEqual({ sucursal: 'STG' })
        expect(cuerpo.dispositivos[0]).toMatchObject({ app: 'crm-apk', estado: 'activo', nombre: 'Samsung A14', sucursal: 'STG', version: '2.3.1' })
        expect(cuerpo.dispositivos[1]).toMatchObject({ estado: 'bloqueado', nombre: 'PC de Palma' })
        expect(cuerpo.truncado).toBe(false)
        expect(cuerpo.siguiente).toBeNull()
    })

    it('`desde` filtra por la última modificación; uno que no es una fecha es 400', async () => {
        db.dispositivo.findMany.mockResolvedValue([])
        await get('?desde=2026-10-29T00:00:00Z')
        expect(db.dispositivo.findMany.mock.calls[0][0].where.AND).toContainEqual({ updatedAt: { gt: new Date('2026-10-29T00:00:00Z') } })
        expect((await get('?desde=ayer')).status).toBe(400)
    })
})

describe('el tope AVISA y el cursor no pierde filas', () => {
    it('pide una fila de más; si vuelve, dice `truncado` y da por dónde seguir', async () => {
        db.dispositivo.findMany.mockResolvedValue([fila(1), fila(2), fila(3)])
        const cuerpo = await (await get('?limite=2')).json()
        expect(db.dispositivo.findMany.mock.calls[0][0].take).toBe(3)
        expect(cuerpo.dispositivos).toHaveLength(2)
        expect(cuerpo.truncado).toBe(true)
        expect(decodificarCursor(cuerpo.siguiente)).toEqual({ updatedAt: new Date('2026-10-29T12:00:02Z'), id: 'd2' })
    })

    it('con cursor, sigue DESPUÉS de esa fila por (hora, id): ni salta ni repite las que comparten hora', async () => {
        db.dispositivo.findMany.mockResolvedValue([])
        const c = codificarCursor({ updatedAt: new Date('2026-10-29T12:00:02Z'), id: 'd2' })
        await get(`?despues=${c}`)
        expect(db.dispositivo.findMany.mock.calls[0][0].where.AND).toContainEqual({
            OR: [{ updatedAt: { gt: new Date('2026-10-29T12:00:02Z') } }, { updatedAt: new Date('2026-10-29T12:00:02Z'), id: { gt: 'd2' } }],
        })
        expect(db.dispositivo.findMany.mock.calls[0][0].orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }])
    })

    it('un cursor inventado es 400, no un error de base; el límite se acota', async () => {
        expect((await get('?despues=basura')).status).toBe(400)
        expect(limiteDe('5')).toBe(5)
        expect(limiteDe('999999')).toBe(LIMITE_MAXIMO)
        expect(limiteDe('0')).toBe(500)
    })
})

describe('la IMPORTACIÓN de lo que la aplicación ya tenía (el aparato v4 del CRM)', () => {
    const V4 = '0f4c9c1e-8a3b-4d0e-9d62-6a1f3b6f2c10'
    const aparato = {
        aparatoId: V4, userId: 'cmt92l4gq008m67mmao9b5eu3', plataforma: 'android', nombre: 'SM-X133', version: '1.0.0',
        primeraVez: '2026-10-13T12:00:00Z', ultimaVez: '2026-10-28T20:00:00Z',
    }

    it('crea el aparato con SU id (v4 incluido), la app de la CREDENCIAL, sus fechas y el modelo como equipo', async () => {
        db.user.findUnique.mockResolvedValue({ id: aparato.userId })
        db.dispositivo.findUnique.mockResolvedValue(null)
        db.dispositivo.create.mockResolvedValue({})
        const r = await post({ dispositivos: [aparato] })
        expect(await r.json()).toEqual({ resultados: [{ aparatoId: V4, resultado: 'creado' }] })
        expect(db.dispositivo.create.mock.calls[0][0].data).toMatchObject({
            clientId: 'crm-apk', aparatoId: V4, userId: aparato.userId, plataforma: 'android', equipo: 'SM-X133', version: '1.0.0',
            primeraVez: new Date('2026-10-13T12:00:00Z'), vistoAt: new Date('2026-10-28T20:00:00Z'),
        })
    })

    it('es IDEMPOTENTE: si ya está, no lo pisa', async () => {
        db.user.findUnique.mockResolvedValue({ id: aparato.userId })
        db.dispositivo.findUnique.mockResolvedValue({ id: 'ya' })
        const r = await post({ dispositivos: [aparato] })
        expect(await r.json()).toEqual({ resultados: [{ aparatoId: V4, resultado: 'ya_existia' }] })
        expect(db.dispositivo.create).not.toHaveBeenCalled()
    })

    it('dice POR QUÉ no entra: persona que no existe, id que no es un UUID', async () => {
        db.user.findUnique.mockResolvedValue(null)
        const r = await post({ dispositivos: [aparato, { ...aparato, aparatoId: 'no-es-uuid' }] })
        expect((await r.json()).resultados).toEqual([
            { aparatoId: V4, resultado: 'persona_inexistente' },
            { aparatoId: 'no-es-uuid', resultado: 'invalido' },
        ])
        expect(db.dispositivo.create).not.toHaveBeenCalled()
    })

    it('la app es la de la credencial: sin scope, 403; con `?app=` ajeno, 403; cuerpo malo, 400', async () => {
        expect((await post({ dispositivos: [aparato] }, ctxCon('callback:create'))).status).toBe(403)
        expect((await post({ dispositivos: [aparato] }, CRM, '?app=reparto')).status).toBe(403)
        expect((await post('no es json')).status).toBe(400)
        expect((await post({ dispositivos: [] })).status).toBe(400)
        expect((await post({ dispositivos: Array.from({ length: 101 }, () => aparato) })).status).toBe(400)
        expect(db.dispositivo.create).not.toHaveBeenCalled()
    })
})
