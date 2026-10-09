/**
 * El cliente de la bandeja de Notify: la línea que separa «caído» de «vacío».
 *
 * `fetchInbox` nunca lanza, y por eso una lista vacía puede significar «no tienes avisos»
 * o «Notify no contesta». `failed` es lo que las distingue, y de ello depende que el
 * panel diga la verdad. Se prueba con `fetch` simulado y la configuración puesta por
 * variables de entorno (el módulo las lee al cargarse, de ahí el import dinámico).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const respuesta = (body: string, status = 200) => new Response(body, { status })

async function cargar(configurado = true) {
    vi.resetModules()
    vi.stubEnv('QB_NOTIFY_URL', configurado ? 'https://notify.test/' : '')
    vi.stubEnv('QB_NOTIFY_KEY_ID', configurado ? 'clave' : '')
    vi.stubEnv('QB_NOTIFY_SECRET', configurado ? 'secreto' : '')
    return import('../inbox')
}

let fetchSimulado: ReturnType<typeof vi.fn>

beforeEach(() => {
    fetchSimulado = vi.fn()
    vi.stubGlobal('fetch', fetchSimulado)
})
afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
})

describe('fetchInbox: caído frente a vacío', () => {
    it('500 de Notify: failed true y sin datos', async () => {
        fetchSimulado.mockResolvedValue(respuesta('boom', 500))
        const { fetchInbox } = await cargar()
        expect(await fetchInbox({ userId: 'u1' })).toEqual({ data: [], nextCursor: null, failed: true })
    })

    it('200 con la bandeja vacía: failed false (es «sin avisos», no un fallo)', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"data":[],"nextCursor":null}'))
        const { fetchInbox } = await cargar()
        expect(await fetchInbox({ userId: 'u1' })).toEqual({ data: [], nextCursor: null, failed: false })
    })

    it('200 con cuerpo vacío tampoco es un fallo', async () => {
        fetchSimulado.mockResolvedValue(respuesta(''))
        const { fetchInbox } = await cargar()
        expect((await fetchInbox({ userId: 'u1' })).failed).toBe(false)
    })

    it('200 con avisos: los devuelve, failed false', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"data":[{"id":"a1"}],"nextCursor":"c2"}'))
        const { fetchInbox } = await cargar()
        const r = await fetchInbox({ userId: 'u1' })
        expect(r.failed).toBe(false)
        expect(r.data).toEqual([{ id: 'a1' }])
        expect(r.nextCursor).toBe('c2')
    })

    it('la red se cae (fetch lanza): failed true, sin lanzar al interfaz', async () => {
        fetchSimulado.mockRejectedValue(new Error('ECONNRESET'))
        const { fetchInbox } = await cargar()
        expect((await fetchInbox({ userId: 'u1' })).failed).toBe(true)
    })

    it('sin configurar (faltan las variables): failed true y ni se intenta la petición', async () => {
        const { fetchInbox } = await cargar(false)
        expect((await fetchInbox({ userId: 'u1' })).failed).toBe(true)
        expect(fetchSimulado).not.toHaveBeenCalled()
    })
})

describe('fetchInbox: la petición', () => {
    it('lleva el userId recibido, el límite y la firma HMAC', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"data":[]}'))
        const { fetchInbox } = await cargar()
        await fetchInbox({ userId: 'u-sesion', limit: 100 })
        const [url, init] = fetchSimulado.mock.calls[0]
        expect(String(url)).toBe('https://notify.test/v1/inbox?limit=100&userId=u-sesion')
        const cabeceras = init.headers as Record<string, string>
        expect(cabeceras['X-QBN-Key-Id']).toBe('clave')
        expect(cabeceras['X-QBN-Signature']).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe('fetchNotification: «no existe» no es «Notify falló»', () => {
    it('200 con el aviso: found', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"id":"a1","recipientUserId":"u1"}'))
        const { fetchNotification } = await cargar()
        expect(await fetchNotification('a1')).toEqual({ kind: 'found', notification: { id: 'a1', recipientUserId: 'u1' } })
    })

    it('el aviso viene envuelto en { data }: también found', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"data":{"id":"a1"}}'))
        const { fetchNotification } = await cargar()
        expect(await fetchNotification('a1')).toEqual({ kind: 'found', notification: { id: 'a1' } })
    })

    it('404 de Notify: not_found', async () => {
        fetchSimulado.mockResolvedValue(respuesta('{"error":"nope"}', 404))
        const { fetchNotification } = await cargar()
        expect(await fetchNotification('nada')).toEqual({ kind: 'not_found' })
    })

    it('500, red caída, sin configurar y 200 sin aviso dentro: failed (nunca not_found)', async () => {
        const { fetchNotification } = await cargar()
        fetchSimulado.mockResolvedValue(respuesta('boom', 500))
        expect(await fetchNotification('a1')).toEqual({ kind: 'failed' })
        fetchSimulado.mockRejectedValue(new Error('ECONNRESET'))
        expect(await fetchNotification('a1')).toEqual({ kind: 'failed' })
        fetchSimulado.mockResolvedValue(respuesta('{}'))
        expect(await fetchNotification('a1')).toEqual({ kind: 'failed' })
        const sinConfigurar = await cargar(false)
        expect(await sinConfigurar.fetchNotification('a1')).toEqual({ kind: 'failed' })
    })

    it('markRead sobre un aviso que ya no existe sigue siendo false (502 en la ruta)', async () => {
        fetchSimulado.mockResolvedValue(respuesta('', 404))
        const { markRead } = await cargar()
        expect(await markRead('a1')).toBe(false)
    })
})
