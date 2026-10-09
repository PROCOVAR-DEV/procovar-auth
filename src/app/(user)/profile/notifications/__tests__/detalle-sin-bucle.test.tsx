/**
 * La página de detalle, EJECUTADA (sin DOM: un mini-React que corre sus hooks): abrir un
 * aviso lo marca como leído UNA vez. Antes, si el POST fallaba y el GET respondía, `readAt`
 * seguía nulo y el efecto repetía POST + GET sin pausa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// --- Un React de mentira: estado por posición, efectos con deps, y re-render si algo cambia.
const rt = vi.hoisted(() => {
    const s = { slots: [] as unknown[], idx: 0, pending: [] as Array<() => unknown>, dirty: false }
    return {
        s,
        reset() { s.slots = []; s.idx = 0; s.pending = []; s.dirty = false },
        useState(init: unknown) {
            const i = s.idx++
            if (!(i in s.slots)) s.slots[i] = typeof init === 'function' ? (init as () => unknown)() : init
            return [s.slots[i], (v: unknown) => {
                const nv = typeof v === 'function' ? (v as (p: unknown) => unknown)(s.slots[i]) : v
                if (!Object.is(nv, s.slots[i])) { s.slots[i] = nv; s.dirty = true }
            }]
        },
        useRef(init: unknown) { const i = s.idx++; return (s.slots[i] ??= { current: init }) },
        useCallback(fn: unknown, deps: unknown[]) {
            const i = s.idx++
            const prev = s.slots[i] as { fn: unknown; deps: unknown[] } | undefined
            if (prev && prev.deps.every((d, k) => Object.is(d, deps[k]))) return prev.fn
            s.slots[i] = { fn, deps }
            return fn
        },
        useEffect(fn: () => unknown, deps?: unknown[]) {
            const i = s.idx++
            const prev = s.slots[i] as { deps: unknown[] } | undefined
            if (!prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]))) s.pending.push(fn)
            s.slots[i] = { deps }
        },
    }
})
vi.mock('react', async (original) => ({
    ...(await original<typeof import('react')>()),
    useState: rt.useState, useRef: rt.useRef, useCallback: rt.useCallback, useEffect: rt.useEffect,
}))
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'a1' }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k, useLocale: () => 'es' }))

import Pagina from '../[id]/page'

const respuesta = (ok: boolean, cuerpo: unknown = {}) => ({ ok, status: ok ? 200 : 502, json: async () => cuerpo })
const vista = (readAt: string | null) => ({
    notification: { id: 'a1', notificationType: 'aviso', status: 'SENT', createdAt: '2026-10-01T10:00:00Z', readAt, archivedAt: null, payload: { title: 'T' }, href: null },
})
const tic = () => new Promise((r) => setTimeout(r, 0))

/** Monta la página y la deja correr `ticks` vueltas: render → efectos → (si hubo cambios) render. */
async function montar(ticks = 40) {
    rt.reset()
    for (let t = 0; t < ticks; t++) {
        if (t === 0 || rt.s.dirty) {
            rt.s.idx = 0; rt.s.dirty = false
            Pagina()
            const efectos = rt.s.pending.splice(0)
            for (const f of efectos) void f()
        }
        await tic()
    }
}

let fetchSimulado: ReturnType<typeof vi.fn>
const llamadas = (metodo: 'GET' | 'POST') =>
    fetchSimulado.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === metodo).length

beforeEach(() => {
    fetchSimulado = vi.fn()
    vi.stubGlobal('fetch', fetchSimulado)
})

describe('detalle de un aviso: marcar leído sin bucle', () => {
    it('el POST falla (502) y el GET sigue devolviendo readAt nulo: UN POST, no un bucle', async () => {
        fetchSimulado.mockImplementation(async (_url: string, init?: { method?: string }) =>
            init?.method === 'POST' ? respuesta(false) : respuesta(true, vista(null)),
        )
        await montar()
        expect(llamadas('POST')).toBe(1)
        // Y no se recarga a la desesperada: solo la carga inicial.
        expect(llamadas('GET')).toBe(1)
    })

    it('el POST va bien: lo marca una vez y recarga una vez', async () => {
        let leido = false
        fetchSimulado.mockImplementation(async (_url: string, init?: { method?: string }) => {
            if (init?.method === 'POST') { leido = true; return respuesta(true, { ok: true }) }
            return respuesta(true, vista(leido ? '2026-10-08T10:00:00Z' : null))
        })
        await montar()
        expect(llamadas('POST')).toBe(1)
        expect(llamadas('GET')).toBe(2)
    })

    it('el POST va bien pero Notify sigue diciendo «sin leer»: tampoco repite', async () => {
        fetchSimulado.mockImplementation(async (_url: string, init?: { method?: string }) =>
            init?.method === 'POST' ? respuesta(true, { ok: true }) : respuesta(true, vista(null)),
        )
        await montar()
        expect(llamadas('POST')).toBe(1)
    })

    it('un aviso ya leído no se vuelve a marcar', async () => {
        fetchSimulado.mockImplementation(async () => respuesta(true, vista('2026-10-08T10:00:00Z')))
        await montar()
        expect(llamadas('POST')).toBe(0)
    })
})
