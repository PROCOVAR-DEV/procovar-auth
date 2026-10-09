import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PERMISSION_CATALOG } from '@/rbac/permissions.catalog'

const db = vi.hoisted(() => ({ user: { findUnique: vi.fn() } }))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
const registro = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: registro }))

import { APLICACIONES } from '@/rbac/procovar'
import { CLIENTES } from '../sync-clients'
import {
    ComprobacionNoDisponible,
    LLAVE_DEL_CLIENTE,
    LLAVES_DE_ENTRADA,
    NOMBRE_DEL_CLIENTE,
    SIN_LLAVE,
    comprobarEntrada,
    entradasDe,
    puedeEntrar,
    urlSinPermiso,
} from '../puerta-de-entrada'

const persona = (opts: { admin?: boolean; activo?: boolean; porDefecto?: string[]; membresias?: string[][] } = {}) => {
    const perm = (ks: string[]) => ks.map((key) => ({ permission: { key } }))
    return {
        isSystemAdmin: opts.admin ?? false,
        activo: opts.activo ?? true,
        defaultRole: opts.porDefecto ? { permissions: perm(opts.porDefecto) } : null,
        members: (opts.membresias ?? []).map((ks) => ({ memberRoles: [{ role: { permissions: perm(ks) } }] })),
    }
}

beforeEach(() => {
    db.user.findUnique.mockReset()
    registro.error.mockReset()
    registro.info.mockReset()
})

describe('el mapa clientId → llave', () => {
    it('cada llave existe en el catálogo de permisos (nada de erratas)', () => {
        const catalogo = new Set(PERMISSION_CATALOG.map((p) => p.key))
        expect(Object.values(LLAVE_DEL_CLIENTE).filter((k) => !catalogo.has(k))).toEqual([])
    })

    it('es el mapa acordado, y asignacion / procovar-sync NO están', () => {
        expect(LLAVE_DEL_CLIENTE).toEqual({
            pedido: 'pedido.entrar',
            analitics: 'analitics.entrar',
            aft: 'aft.entrar',
            ccsa: 'ccsa.entrar',
            delivery: 'delivery.entrar',
            reparto: 'delivery.entrar',
            'delivery-apk': 'delivery.entrar',
            'procovar-rutas': 'rutas.entrar',
            'procovar-notify': 'avisos.entrar',
        })
    })

    it('cada aplicación con llave tiene nombre para decirle a la persona a cuál no entra', () => {
        expect(Object.keys(NOMBRE_DEL_CLIENTE).sort()).toEqual(Object.keys(LLAVE_DEL_CLIENTE).sort())
    })
})

describe('cada clientId conocido está DECIDIDO: con llave en el mapa, o en SIN_LLAVE', () => {
    // Una errata o un cliente nuevo que no figure en ninguna de las dos listas FALLA ABIERTO
    // (entra sin comprobar nada). Aquí se obliga a decidirlo antes de desplegar.
    const conocidos = [...CLIENTES.map((c) => c.clientId), ...APLICACIONES.map((a) => a.clientId)]

    it('los de sync-clients.ts y los del seed (rbac/procovar.ts) están en el mapa o en SIN_LLAVE', () => {
        const sinDecidir = conocidos.filter((c) => !Object.hasOwn(LLAVE_DEL_CLIENTE, c) && !SIN_LLAVE.includes(c))
        expect(sinDecidir).toEqual([])
    })

    it('hay ids de verdad que comparar (no pasa por estar vacío)', () => {
        expect(conocidos).toEqual(expect.arrayContaining(['procovar-rutas', 'procovar-notify', 'aft', 'asignacion', 'procovar-sync', 'pedido', 'ccsa', 'portal']))
    })

    it('ninguno está en las dos a la vez, y SIN_LLAVE no repite', () => {
        expect(SIN_LLAVE.filter((c) => Object.hasOwn(LLAVE_DEL_CLIENTE, c))).toEqual([])
        expect(new Set(SIN_LLAVE).size).toBe(SIN_LLAVE.length)
    })

    it('asignacion, procovar-sync y crm están decididos como sin llave', () => {
        expect(SIN_LLAVE).toEqual(expect.arrayContaining(['asignacion', 'procovar-sync', 'crm']))
    })
})

describe('puedeEntrar', () => {
    it('sin la llave NO entra, aunque tenga otras', async () => {
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['pedido.entrar', 'analitics.read'] }))
        expect(await puedeEntrar('u1', 'procovar-rutas')).toBe(false)
        expect(await puedeEntrar('u1', 'delivery-apk')).toBe(false)
    })

    it('con la llave entra, venga del rol por defecto o de una membresía (unión)', async () => {
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['pedido.entrar'], membresias: [['aft.entrar'], ['rutas.entrar']] }))
        expect(await puedeEntrar('u1', 'pedido')).toBe(true)
        expect(await puedeEntrar('u1', 'aft')).toBe(true)
        expect(await puedeEntrar('u1', 'procovar-rutas')).toBe(true)
        expect(await puedeEntrar('u1', 'ccsa')).toBe(false)
    })

    it('delivery, reparto y delivery-apk se abren con la MISMA llave', async () => {
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['delivery.entrar'] }))
        for (const c of ['delivery', 'reparto', 'delivery-apk']) expect(await puedeEntrar('u1', c)).toBe(true)
    })

    it('el administrador de sistema entra siempre, sin llaves', async () => {
        db.user.findUnique.mockResolvedValue(persona({ admin: true }))
        for (const c of Object.keys(LLAVE_DEL_CLIENTE)) expect(await puedeEntrar('u1', c)).toBe(true)
    })

    it('un clientId sin mapa pasa como hoy, y ni siquiera toca la base', async () => {
        for (const c of ['unknown', 'procovar-crm', '__proto__', 'constructor', '', null, undefined]) {
            expect(await puedeEntrar('u1', c)).toBe(true)
        }
        expect(db.user.findUnique).not.toHaveBeenCalled()
    })

    it('un clientId sin mapa deja un logger.info (sin datos personales) y uno con mapa no', async () => {
        await puedeEntrar('u1', 'id-mal-escrito')
        expect(registro.info).toHaveBeenCalledTimes(1)
        const dicho = JSON.stringify(registro.info.mock.calls[0])
        expect(dicho).toContain('id-mal-escrito')
        expect(dicho).not.toContain('u1')

        registro.info.mockReset()
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['pedido.entrar'] }))
        await puedeEntrar('u1', 'pedido')
        expect(registro.info).not.toHaveBeenCalled()
    })

    // El `select` de `accesoDe` lo ignoran todos los mocks (devuelven el objeto entero), así que quitar
    // `isSystemAdmin` o `activo` de él dejaba el verde: en producción dejaría FUERA de todas las
    // aplicaciones a cada Super Admin (callback, exchange y ?op= no pasan `isSystemAdmin` por parámetro).
    it('pide a la base `isSystemAdmin` y `activo` (el select no se puede aflojar sin que falle esto)', async () => {
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['pedido.entrar'] }))
        await puedeEntrar('u1', 'pedido')
        expect(db.user.findUnique.mock.calls[0][0].select).toMatchObject({ isSystemAdmin: true, activo: true })
    })

    it('si la base falla, DENIEGA y deja el error en el registro (falla cerrado)', async () => {
        db.user.findUnique.mockRejectedValue(new Error('conexión caída'))
        expect(await puedeEntrar('u1', 'aft')).toBe(false)
        expect(registro.error).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(registro.error.mock.calls[0])).toContain('conexión caída')
    })

    it('una persona que no existe en la base no entra', async () => {
        db.user.findUnique.mockResolvedValue(null)
        expect(await puedeEntrar('fantasma', 'pedido')).toBe(false)
    })
})

describe('comprobarEntrada: la de la APK LANZA si la base falla', () => {
    it('con la base caída lanza ComprobacionNoDisponible (con la causa), no devuelve false', async () => {
        db.user.findUnique.mockRejectedValue(new Error('conexión caída'))
        const error = await comprobarEntrada('u1', 'delivery-apk').catch((e) => e)
        expect(error).toBeInstanceOf(ComprobacionNoDisponible)
        expect(error.message).toContain('conexión caída')
        expect((error.cause as Error).message).toBe('conexión caída')
    })

    it('sin fallo contesta igual que puedeEntrar', async () => {
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['delivery.entrar'] }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(true)
        db.user.findUnique.mockResolvedValue(persona({ porDefecto: ['pedido.entrar'] }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(false)
        db.user.findUnique.mockResolvedValue(persona({ admin: true }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(true)
    })

    it('un clientId sin mapa no toca la base, así que la base caída no lo alcanza', async () => {
        db.user.findUnique.mockRejectedValue(new Error('conexión caída'))
        expect(await comprobarEntrada('u1', 'asignacion')).toBe(true)
    })
})

describe('una cuenta de baja (activo=false): la APK la deja pasar (la cierra resolverIdentidad); la WEB no', () => {
    const clientes = Object.keys(LLAVE_DEL_CLIENTE)

    it('APK: comprobarEntrada la deja pasar, con o sin la llave (no es sin_permiso: el cierre es `revoked`)', async () => {
        db.user.findUnique.mockResolvedValue(persona({ activo: false, porDefecto: ['pedido.entrar'] }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(true)
        db.user.findUnique.mockResolvedValue(persona({ activo: false, porDefecto: ['delivery.entrar'] }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(true)
    })

    it('WEB: puedeEntrar NO la deja entrar a NINGUNA aplicación, tenga las llaves que tenga (o sea administradora)', async () => {
        for (const m of [persona({ activo: false }), persona({ activo: false, porDefecto: [...new Set(Object.values(LLAVE_DEL_CLIENTE))] }), persona({ activo: false, admin: true })]) {
            db.user.findUnique.mockResolvedValue(m)
            for (const c of clientes) expect(await puedeEntrar('u1', c), c).toBe(false)
        }
    })

    it('WEB, canje en /exchange (`bajaPasa: false`): tampoco; y la APK (por defecto) sigue pasando', async () => {
        db.user.findUnique.mockResolvedValue(persona({ activo: false, porDefecto: ['pedido.entrar'] }))
        for (const c of clientes) expect(await comprobarEntrada('u1', c, { bajaPasa: false }), c).toBe(false)
        expect(await comprobarEntrada('u1', 'pedido')).toBe(true)
    })

    // BAJO-4 (auditoría A1): el atajo de «el cliente no tiene llave» salía con `true` ANTES de mirar la baja.
    // Los clientes decididos como SIN_LLAVE (asignacion, crm, rutas, portal, procovar-sync...) no tienen
    // llave, pero una baja tampoco debe canjear un código de ellos. Los ids que no están en ninguna lista
    // (erratas) siguen pasando sin tocar la base (ver «un clientId sin mapa pasa como hoy»).
    describe('clientes SIN_LLAVE: la baja se mira antes del atajo (WEB), la APK sigue pasando', () => {
        const bajas = () => [persona({ activo: false }), persona({ activo: false, admin: true }), persona({ activo: false, porDefecto: [...new Set(Object.values(LLAVE_DEL_CLIENTE))] })]

        it('la lista no está vacía y trae los cinco del informe', () => {
            expect(SIN_LLAVE).toEqual(expect.arrayContaining(['asignacion', 'crm', 'rutas', 'portal', 'procovar-sync']))
        })

        for (const c of SIN_LLAVE) {
            it(`${c}: una baja NO entra por la web (puedeEntrar y comprobarEntrada con bajaPasa:false), tenga lo que tenga`, async () => {
                for (const baja of bajas()) {
                    db.user.findUnique.mockResolvedValue(baja)
                    expect(await puedeEntrar('u1', c), c).toBe(false)
                    expect(await comprobarEntrada('u1', c, { bajaPasa: false }), c).toBe(false)
                }
            })

            it(`${c}: una cuenta activa (con o sin llaves) sigue entrando por la web, y la baja sigue pasando por la APK`, async () => {
                db.user.findUnique.mockResolvedValue(persona({ activo: true }))
                expect(await puedeEntrar('u1', c), c).toBe(true)
                expect(await comprobarEntrada('u1', c, { bajaPasa: false }), c).toBe(true)
                db.user.findUnique.mockResolvedValue(persona({ activo: false }))
                db.user.findUnique.mockClear()
                expect(await comprobarEntrada('u1', c), c).toBe(true) // APK: bajaPasa por defecto, ni toca la base
                expect(db.user.findUnique).not.toHaveBeenCalled()
            })

            it(`${c}: si la base falla, la web NO entra (cierra) y el canje lanza ComprobacionNoDisponible`, async () => {
                db.user.findUnique.mockRejectedValue(new Error('conexión caída'))
                expect(await puedeEntrar('u1', c), c).toBe(false)
                await expect(comprobarEntrada('u1', c, { bajaPasa: false })).rejects.toBeInstanceOf(ComprobacionNoDisponible)
            })
        }
    })

    it('una cuenta ACTIVA no cambia: sin la llave no entra, con ella sí, la administradora entra a todo', async () => {
        db.user.findUnique.mockResolvedValue(persona({ activo: true, porDefecto: ['pedido.entrar'] }))
        expect(await comprobarEntrada('u1', 'delivery-apk')).toBe(false)
        expect(await puedeEntrar('u1', 'delivery-apk')).toBe(false)
        expect(await puedeEntrar('u1', 'pedido')).toBe(true)
        db.user.findUnique.mockResolvedValue(persona({ activo: true, admin: true }))
        for (const c of clientes) expect(await puedeEntrar('u1', c), c).toBe(true)
    })
})

describe('entradasDe: las llaves de entrada que se FIRMAN', () => {
    const acceso = (...llaves: string[]) => ({ todo: false, llaves: new Set(llaves) })

    it('son siete, sin repetir, en el orden del mapa', () => {
        expect(LLAVES_DE_ENTRADA).toEqual([
            'pedido.entrar',
            'analitics.entrar',
            'aft.entrar',
            'ccsa.entrar',
            'delivery.entrar',
            'rutas.entrar',
            'avisos.entrar',
        ])
    })

    it('con delivery.entrar está; sin ella no está pero el campo existe', () => {
        expect(entradasDe(acceso('delivery.entrar'))).toEqual(['delivery.entrar'])
        expect(entradasDe(acceso('pedido.entrar'))).toEqual(['pedido.entrar'])
        expect(entradasDe(acceso('pedido.entrar'))).not.toContain('delivery.entrar')
    })

    it('una persona sin llaves: [] (existe y está vacío: «no entra a nada»)', () => {
        expect(entradasDe(acceso())).toEqual([])
        expect(entradasDe(acceso('pedido.read', 'reparto.read'))).toEqual([])
    })

    it('el administrador de sistema: TODAS, aunque no traiga llaves', () => {
        expect(entradasDe({ todo: true, llaves: new Set() })).toEqual([...LLAVES_DE_ENTRADA])
    })

    it('sólo las del mapa: una llave de entrada que Accesos no firma (entrega.entrar) no sale', () => {
        expect(entradasDe(acceso('entrega.entrar', 'pedido.entrar'))).toEqual(['pedido.entrar'])
    })

    it('orden estable (el del mapa) venga como venga, y devuelve una copia', () => {
        expect(entradasDe(acceso('avisos.entrar', 'aft.entrar', 'pedido.entrar'))).toEqual(['pedido.entrar', 'aft.entrar', 'avisos.entrar'])
        const todas = entradasDe({ todo: true, llaves: new Set() })
        todas.push('x')
        expect(entradasDe({ todo: true, llaves: new Set() })).toHaveLength(7)
    })
})

describe('urlSinPermiso', () => {
    it('es una pantalla de Accesos: ni el flujo ni el callback ni una aplicación', () => {
        const u = new URL(urlSinPermiso('procovar-rutas'), 'https://auth.example.com')
        expect(u.pathname).toBe('/sin-permiso')
        expect(u.searchParams.get('app')).toBe('procovar-rutas')
        expect(u.origin).toBe('https://auth.example.com')
    })
})
