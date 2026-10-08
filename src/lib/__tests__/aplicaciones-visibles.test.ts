import { describe, it, expect, vi, beforeEach } from 'vitest'
import { prisma } from '@/lib/prisma'
import { APLICACIONES } from '@/rbac/procovar'
import { PERMISSION_CATALOG } from '@/rbac/permissions.catalog'
import { systemRolePermissionKeys } from '@/rbac/system-roles'
import {
    APLICACIONES_DE_LA_CASA,
    LLAVE_DE_ENTRADA,
    accesoDe,
    aplicacionesVisibles,
    type Acceso,
} from '../aplicaciones-visibles'

// Sin base de datos en el test: `accesoDe` sólo pregunta por `user.findUnique`.
vi.mock('@/lib/prisma', () => ({ prisma: { user: { findUnique: vi.fn() } } }))

const conLlaves = (...llaves: string[]): Acceso => ({ todo: false, llaves: new Set(llaves) })
const ids = (acceso: Acceso) => aplicacionesVisibles(APLICACIONES_DE_LA_CASA, acceso).map((a) => a.clientId)
const delRol = (rol: string) => conLlaves(...systemRolePermissionKeys(rol))

// Las que no tienen llave de entrada: se enseñan a quien tenga alguna.
const SIN_LLAVE = Object.entries(LLAVE_DE_ENTRADA).filter(([, k]) => k === null).map(([c]) => c)

describe('el mapa aplicación → llave de entrada', () => {
    it('cubre TODAS las aplicaciones de APLICACIONES (rbac/procovar.ts)', () => {
        // Si se añade una aplicación nueva sin decir con qué llave se entra, falla aquí.
        const sinMapa = APLICACIONES.map((a) => a.clientId).filter((c) => !(c in LLAVE_DE_ENTRADA))
        expect(sinMapa).toEqual([])
    })

    it('cubre todas las tarjetas de «A dónde ir», y no deja ninguna aplicación fuera de ellas', () => {
        const tarjetas = APLICACIONES_DE_LA_CASA.map((a) => a.clientId)
        expect(tarjetas.filter((c) => !(c in LLAVE_DE_ENTRADA))).toEqual([])
        expect(APLICACIONES.map((a) => a.clientId).filter((c) => !tarjetas.includes(c))).toEqual([])
        expect(new Set(tarjetas).size).toBe(tarjetas.length)
    })

    it('cada llave del mapa existe en el catálogo de permisos (nada de erratas)', () => {
        const catalogo = new Set(PERMISSION_CATALOG.map((p) => p.key))
        const inventadas = Object.values(LLAVE_DE_ENTRADA).filter((k): k is string => k !== null && !catalogo.has(k))
        expect(inventadas).toEqual([])
    })

    it('las que no tienen llave son exactamente las que el catálogo no tiene (entrega, caja, traslado, portal)', () => {
        expect([...SIN_LLAVE].sort()).toEqual(['caja', 'entrega', 'portal', 'traslado'])
        const catalogo = new Set(PERMISSION_CATALOG.map((p) => p.key))
        for (const c of SIN_LLAVE) expect(catalogo.has(`${c}.entrar`)).toBe(false)
    })
})

describe('aplicacionesVisibles', () => {
    it('un administrador de sistema las ve todas', () => {
        expect(ids({ todo: true, llaves: new Set() })).toEqual(APLICACIONES_DE_LA_CASA.map((a) => a.clientId))
    })

    it('SUPER ADMIN (por sus llaves, sin comodín) ve todas las que tienen llave, más el Portal', () => {
        expect(ids(delRol('SUPER ADMIN'))).toEqual(
            APLICACIONES_DE_LA_CASA.map((a) => a.clientId).filter((c) => LLAVE_DE_ENTRADA[c] !== null || c === 'portal'),
        )
    })

    it('un GESTOR no ve las aplicaciones que sus llaves no cubren', () => {
        const vistas = ids(delRol('GESTOR'))
        expect(vistas).toContain('pedido')
        for (const ajena of ['analitics', 'rutas', 'ccsa', 'aft']) expect(vistas).not.toContain(ajena)
    })

    it('sólo se enseña lo que la llave dice, más el Portal; Entrega, Caja y Traslado NO (ningún rol tiene acceso registrado)', () => {
        expect(ids(conLlaves('analitics.entrar'))).toEqual(['analitics', 'portal'])
    })

    it('el administrador de sistema sí ve las aplicaciones sin llave', () => {
        const vistas = aplicacionesVisibles(APLICACIONES_DE_LA_CASA, { todo: true, llaves: new Set() }).map((a) => a.clientId)
        for (const c of ['entrega', 'caja', 'traslado', 'portal']) expect(vistas).toContain(c)
    })

    it('el rol sin ninguna llave de entrada no ve nada (ni siquiera el Portal)', () => {
        expect(ids(conLlaves())).toEqual([])
        // `analitics.read` no es entrar: tener otras llaves no abre la puerta.
        expect(ids(conLlaves('analitics.read', 'pedido.read'))).toEqual([])
    })

    it('quien lleva dos roles ve la unión de lo de cada uno', () => {
        const gestor = ids(conLlaves('pedido.entrar'))
        const economica = ids(conLlaves('aft.entrar'))
        const ambos = ids(conLlaves('pedido.entrar', 'aft.entrar'))
        expect(ambos).toEqual(APLICACIONES_DE_LA_CASA.map((a) => a.clientId).filter((c) => gestor.includes(c) || economica.includes(c)))
        expect(ambos).toContain('pedido')
        expect(ambos).toContain('aft')
    })

    it('si el rol pierde una llave, la aplicación desaparece sola', () => {
        expect(ids(conLlaves('pedido.entrar', 'delivery.entrar'))).toContain('delivery')
        expect(ids(conLlaves('pedido.entrar'))).not.toContain('delivery')
    })

    it('una aplicación que no está en el mapa no se enseña', () => {
        const apps = [{ clientId: 'nueva' }, { clientId: 'pedido' }]
        expect(aplicacionesVisibles(apps, conLlaves('pedido.entrar'))).toEqual([{ clientId: 'pedido' }])
    })
})

describe('accesoDe (las llaves reales de la persona)', () => {
    const permisos = (...keys: string[]) => keys.map((key) => ({ permission: { key } }))
    const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>

    beforeEach(() => findUnique.mockReset())

    it('el administrador de sistema no pregunta a la base: lo ve todo', async () => {
        expect(await accesoDe('u1', true)).toEqual({ todo: true, llaves: new Set() })
        expect(findUnique).not.toHaveBeenCalled()
    })

    it('suma el rol por defecto y los roles de TODAS las membresías', async () => {
        findUnique.mockResolvedValueOnce({
            defaultRole: { permissions: permisos('pedido.entrar') },
            members: [
                { memberRoles: [{ role: { permissions: permisos('aft.entrar') } }] },
                { memberRoles: [{ role: { permissions: permisos('rutas.entrar', 'pedido.entrar') } }, { role: { permissions: [] } }] },
            ],
        })
        const acceso = await accesoDe('u1', false)
        expect([...acceso.llaves].sort()).toEqual(['aft.entrar', 'pedido.entrar', 'rutas.entrar'])
        expect(ids(acceso)).toEqual(expect.arrayContaining(['pedido', 'aft', 'rutas']))
        expect(ids(acceso)).not.toContain('analitics')
    })

    it('salta las filas que apuntan a un permiso que ya no existe', async () => {
        findUnique.mockResolvedValueOnce({
            defaultRole: { permissions: [{ permission: null }, ...permisos('pedido.entrar')] },
            members: [],
        })
        expect([...(await accesoDe('u1', false)).llaves]).toEqual(['pedido.entrar'])
    })

    it('sin rol y sin membresías: ninguna llave, y por tanto ninguna aplicación', async () => {
        findUnique.mockResolvedValueOnce({ defaultRole: null, members: [] })
        expect(ids(await accesoDe('u1', false))).toEqual([])
        findUnique.mockResolvedValueOnce(null)
        expect(ids(await accesoDe('fantasma', false))).toEqual([])
    })
})
