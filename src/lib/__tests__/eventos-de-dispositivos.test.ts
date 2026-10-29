/** El aviso de que un aparato cambió: UN CANAL POR APLICACIÓN, y un fallo de Redis nunca rompe la acción del administrador. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redis = vi.hoisted(() => ({ publish: vi.fn(), on: vi.fn(), duplicate: vi.fn() }))
vi.mock('@/lib/redis', () => ({ getRedis: () => ({ duplicate: () => ({ publish: redis.publish, on: redis.on }) }) }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

import { avisarDeDispositivo, avisoDe, canalDe } from '../eventos-de-dispositivos'

const D = { clientId: 'crm-apk', aparatoId: '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10', bloqueadoAt: null as Date | null }

beforeEach(() => { vi.clearAllMocks(); delete (globalThis as { __procovarDispositivosRedis?: unknown }).__procovarDispositivosRedis })

describe('el mensaje', () => {
    it('lleva la app, el aparato, el estado, el motivo y la hora', () => {
        expect(avisoDe(D, 'desbloqueado', 1234)).toEqual({
            v: 1, tipo: 'dispositivo-cambiado', app: 'crm-apk', aparatoId: D.aparatoId, estado: 'activo', motivo: 'desbloqueado', tms: 1234,
        })
        expect(avisoDe({ ...D, bloqueadoAt: new Date() }, 'bloqueado', 1).estado).toBe('bloqueado')
    })
})

describe('el canal', () => {
    it('es UNO POR APLICACIÓN: el del CRM no es el de Reparto', async () => {
        redis.publish.mockResolvedValue(1)
        expect(canalDe('crm-apk')).toBe('procovar:auth:dispositivos:crm-apk')
        await avisarDeDispositivo(D, 'bloqueado')
        await avisarDeDispositivo({ ...D, clientId: 'delivery-apk' }, 'bloqueado')
        expect(redis.publish.mock.calls.map((c) => c[0])).toEqual([
            'procovar:auth:dispositivos:crm-apk', 'procovar:auth:dispositivos:delivery-apk',
        ])
        expect(JSON.parse(redis.publish.mock.calls[0][1])).toMatchObject({ app: 'crm-apk', aparatoId: D.aparatoId })
    })

    it('si Redis falla, NO lanza: devuelve false (la acción del administrador ya está hecha)', async () => {
        redis.publish.mockRejectedValue(new Error('redis caído'))
        await expect(avisarDeDispositivo(D, 'bloqueado')).resolves.toBe(false)
    })
})
