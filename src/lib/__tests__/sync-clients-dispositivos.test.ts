/** `syncClients` reescribe los scopes en cada arranque: el del CRM para sus dispositivos tiene que estar en el catálogo, no solo en la migración. */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../prisma', () => ({ prisma: {} }))

import { CLIENTES } from '../sync-clients'
import { appsPermitidas } from '../dispositivos-lista'

describe('el catálogo de clientes y los dispositivos', () => {
    it('el CRM puede gestionar los dispositivos de su APK (y de ninguna otra)', () => {
        const crm = CLIENTES.find((c) => c.clientId === 'crm')!
        expect(appsPermitidas(crm.scopes)).toEqual(['crm-apk'])
    })
    it('ningún otro cliente del catálogo ve dispositivos', () => {
        for (const c of CLIENTES.filter((c) => c.clientId !== 'crm')) expect(appsPermitidas(c.scopes)).toEqual([])
    })
})
