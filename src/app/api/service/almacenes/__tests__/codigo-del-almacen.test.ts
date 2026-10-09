/**
 * El CÓDIGO del almacén (el `objectCode` de Ventra) en /api/service/almacenes.
 *
 * Sin él Reparto mide TODOS los pedidos desde el almacén principal (9.000 pedidos, 09/10/2026:
 * `accesos-sin-codigos`). Lo delicado no es guardarlo, es NO borrarlo sin querer: el PUT manda la
 * lista completa y los clientes viejos de Reparto (APK/Windows/web en caché) no mandan el campo.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => {
    const d: Record<string, any> = {
        organization: { findUnique: vi.fn(), findMany: vi.fn() },
        almacen: { deleteMany: vi.fn(), updateMany: vi.fn(), update: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    }
    d.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(d))
    return d
})

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/with-service-auth', () => ({ withServiceAuth: (h: unknown) => h }))

import { GET, PUT } from '../route'

const put = (cuerpo: unknown) =>
    (PUT as unknown as (r: Request) => Promise<Response>)(
        new Request('http://x/api/service/almacenes', { method: 'PUT', body: JSON.stringify(cuerpo) }),
    )

const A = { id: 'a1', nombre: 'PV STGO' }
const B = { id: 'a2', nombre: 'AURORA' }
const dataDe = (llamada: number) => db.almacen.update.mock.calls[llamada][0].data

beforeEach(() => {
    vi.clearAllMocks()
    db.organization.findUnique.mockResolvedValue({ id: 'org-stg' })
    db.almacen.findMany.mockResolvedValue([])
})

describe('GET', () => {
    it('devuelve el código de cada almacén', async () => {
        db.organization.findMany.mockResolvedValue([
            { codigo: 'STG', name: 'Santiago', almacenes: [{ id: 'a1', nombre: 'PV-STGO', codigo: '1' }] },
        ])
        const res = await (GET as unknown as (r: Request) => Promise<Response>)(new Request('http://x/api/service/almacenes?codigo=STG'))
        const cuerpo = await res.json()
        expect(cuerpo.sucursales[0].almacenes[0].codigo).toBe('1')
        expect(db.organization.findMany.mock.calls[0][0].select.almacenes.select.codigo).toBe(true)
    })
})

describe('PUT', () => {
    it('guarda el código sin espacios y en mayúsculas', async () => {
        const res = await put({ codigo: 'STG', almacenes: [{ ...A, codigo: ' ab12 ' }] })
        expect(res.status).toBe(200)
        expect(dataDe(0).codigo).toBe('AB12')
    })

    it('AUSENTE no toca el código que ya tiene (cliente viejo de Reparto)', async () => {
        await put({ codigo: 'STG', almacenes: [A, B] })
        expect('codigo' in dataDe(0)).toBe(false)
        expect('codigo' in dataDe(1)).toBe(false)
        // y no se libera ninguno para recodificar
        expect(db.almacen.updateMany).not.toHaveBeenCalled()
    })

    it('"" y null LO QUITAN', async () => {
        await put({ codigo: 'STG', almacenes: [{ ...A, codigo: '' }, { ...B, codigo: null }] })
        expect(dataDe(0).codigo).toBeNull()
        expect(dataDe(1).codigo).toBeNull()
    })

    it('el mismo código en dos almacenes de la misma sucursal es 409 y no escribe nada', async () => {
        const res = await put({ codigo: 'STG', almacenes: [{ ...A, codigo: 'x1' }, { ...B, codigo: ' X1 ' }] })
        expect(res.status).toBe(409)
        expect((await res.json()).error).toMatch(/PV STGO.*AURORA/)
        expect(db.$transaction).not.toHaveBeenCalled()
    })

    it('intercambiar dos códigos libera primero los que cambian (el índice único no choca a mitad)', async () => {
        const orden: string[] = []
        db.almacen.updateMany.mockImplementation(async () => { orden.push('liberar') })
        db.almacen.update.mockImplementation(async () => { orden.push('poner') })
        await put({ codigo: 'STG', almacenes: [{ ...A, codigo: '2' }, { ...B, codigo: '1' }] })
        expect(db.almacen.updateMany.mock.calls[0][0]).toEqual({
            where: { orgId: 'org-stg', id: { in: ['a1', 'a2'] } },
            data: { codigo: null },
        })
        expect(orden).toEqual(['liberar', 'poner', 'poner'])
    })

    it('solo se liberan los almacenes que traen código; los que no, conservan el suyo', async () => {
        await put({ codigo: 'STG', almacenes: [{ ...A, codigo: '2' }, B] })
        expect(db.almacen.updateMany.mock.calls[0][0].where.id.in).toEqual(['a1'])
    })

    it('si otra petición ganó el código (P2002) contesta 409, no 500', async () => {
        db.almacen.update.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }))
        const res = await put({ codigo: 'STG', almacenes: [{ ...A, codigo: '2' }] })
        expect(res.status).toBe(409)
    })

    it('cualquier otro error de la base sigue siendo un error (no se disfraza de 409)', async () => {
        db.almacen.update.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'P2010' }))
        await expect(put({ codigo: 'STG', almacenes: [{ ...A, codigo: '2' }] })).rejects.toThrow('boom')
    })

    it('un código de más de 40 letras es 400', async () => {
        const res = await put({ codigo: 'STG', almacenes: [{ ...A, codigo: 'x'.repeat(41) }] })
        expect(res.status).toBe(400)
    })

    it('un almacén nuevo (sin id) se crea con su código', async () => {
        await put({ codigo: 'STG', almacenes: [{ nombre: 'NUEVO', codigo: '7' }] })
        expect(db.almacen.create.mock.calls[0][0].data).toMatchObject({ nombre: 'NUEVO', codigo: '7', orgId: 'org-stg' })
    })
})
