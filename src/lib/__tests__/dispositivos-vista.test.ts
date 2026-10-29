/** Lo que la pantalla «Dispositivos» enseña: pestañas, marcas, el enlace a «Ver actividad» (solo http/https) y el resumen. */
import { describe, it, expect } from 'vitest'
import { aFila, aFilaDeAparato, contarMarcas, nombreDeApp, pestanas, urlDeActividad, type DispositivoDeBD } from '../dispositivos-vista'

const AHORA = new Date('2026-10-29T18:00:00Z')
const hace = (h: number) => new Date(AHORA.getTime() - h * 3_600_000)

const D: DispositivoDeBD = {
    id: 'd1', aparatoId: '0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10', userId: 'u1', clientId: 'delivery-apk', sucursal: 'STG',
    plataforma: 'Windows', version: '1.0.47', equipo: 'PC de Maikel', nombre: null, vistoAt: hace(1), primeraVez: hace(100),
    ultimaDescarga: hace(1), ultimaSubida: hace(1), pendientes: 0, rechazados: 0, ultimoError: null, estadoAt: hace(1), bloqueadoAt: null,
}

describe('las pestañas', () => {
    it('Reparto y el CRM siempre están, aunque no tengan aparatos; las demás con aparatos se añaden, sin repetir', () => {
        expect(pestanas([]).map((p) => p.clientId)).toEqual(['delivery-apk', 'crm-apk'])
        expect(pestanas(['zeta-apk', 'crm-apk', 'alfa-apk', 'zeta-apk']).map((p) => p.clientId)).toEqual(['delivery-apk', 'crm-apk', 'alfa-apk', 'zeta-apk'])
    })
    it('se leen como «Reparto» y «CRM»; un nombre desconocido sale tal cual', () => {
        expect(pestanas([]).map((p) => p.nombre)).toEqual(['Reparto', 'CRM'])
        expect(nombreDeApp('otra-apk')).toBe('otra-apk')
    })
})

describe('«Ver actividad»', () => {
    it('rellena el hueco {aparatoId} (escapado) y solo vale http o https', () => {
        expect(urlDeActividad('https://crm.procovar.cloud/dispositivos/{aparatoId}', 'abc')).toBe('https://crm.procovar.cloud/dispositivos/abc')
        expect(urlDeActividad('https://x.example/d?id={aparatoId}', 'a b&c')).toBe('https://x.example/d?id=a%20b%26c')
    })
    it('sin plantilla, sin hueco o con un esquema peligroso: ninguno', () => {
        expect(urlDeActividad(null, 'abc')).toBeNull()
        expect(urlDeActividad('https://x.example/fijo', 'abc')).toBeNull()
        expect(urlDeActividad('javascript:alert({aparatoId})', 'abc')).toBeNull()
        expect(urlDeActividad('not a url {aparatoId}', 'abc')).toBeNull()
    })
})

describe('la fila', () => {
    const personas = new Map([['u1', 'Maikel']])
    it('lleva la persona, la marca, el nombre y el enlace', () => {
        const f = aFila(D, personas, 'https://x.example/{aparatoId}', AHORA)
        expect(f).toMatchObject({
            persona: 'Maikel', marca: 'funciona', nombre: 'PC de Maikel', nombrePuesto: null, bloqueado: false,
            actividadUrl: 'https://x.example/0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10',
        })
    })
    it('el nombre de un administrador manda sobre el del aparato, y se puede distinguir', () => {
        const f = aFila({ ...D, nombre: 'La del almacén' }, personas, null, AHORA)
        expect(f.nombre).toBe('La del almacén')
        expect(f.nombrePuesto).toBe('La del almacén')
        expect(f.actividadUrl).toBeNull()
    })
    it('una persona dada de baja no rompe la fila; un bloqueado se marca bloqueado', () => {
        const f = aFila({ ...D, userId: 'borrada', bloqueadoAt: hace(2) }, personas, null, AHORA)
        expect(f.persona).toBe('Persona dada de baja')
        expect(f.marca).toBe('bloqueado')
        expect(f.bloqueado).toBe(true)
    })
    it('TODAS las cuentas que entraron en el aparato, la más reciente primero, con su nombre', () => {
        const nombres = new Map([['u1', 'Dainel'], ['u2', 'Amado'], ['u3', 'Javier']])
        const f = aFila({
            ...D, userId: 'u2',
            personas: [
                { userId: 'u1', primeraVez: hace(30), vistoAt: hace(20), version: '1.0.45' },
                { userId: 'u2', primeraVez: hace(2), vistoAt: hace(1), version: '1.0.47' },
                { userId: 'u3', primeraVez: hace(40), vistoAt: hace(10), version: '1.0.45' },
            ],
        }, nombres, null, AHORA)
        expect(f.cuentas.map((c) => c.persona)).toEqual(['Amado', 'Javier', 'Dainel'])
        expect(f.cuentas[0]).toMatchObject({ version: '1.0.47' })
        expect(f.persona).toBe('Amado')
    })
    it('UN MISMO APARATO en varias aplicaciones sale una vez por pestaña, y dice en qué otras está (sin repetir ni contar la propia)', () => {
        expect(aFila({ ...D, tambienEn: ['crm-apk', 'crm-apk'] }, personas, null, AHORA).tambienEn).toEqual(['CRM'])
        expect(aFila(D, personas, null, AHORA).tambienEn).toEqual([])
    })
    it('sin cuentas anotadas (un aparato anterior) no rompe: lista vacía', () => {
        expect(aFila(D, new Map(), null, AHORA).cuentas).toEqual([])
    })
    it('el resumen cuenta cada marca', () => {
        const filas = [D, { ...D, rechazados: 2 }, { ...D, vistoAt: hace(500) }, { ...D, bloqueadoAt: hace(1) }, { ...D, estadoAt: null }]
            .map((d) => aFila(d, personas, null, AHORA))
        expect(contarMarcas(filas)).toEqual({ funciona: 1, atascado: 1, callado: 1, bloqueado: 1, sin_estado: 1 })
    })
})

describe('la pestaña «Todos»: el aparato una vez, con una etiqueta por aplicación', () => {
    const { id: _i, aparatoId: _a, plataforma: _p, equipo: _e, nombre: _n, ...app } = D
    it('une Reparto y el CRM del mismo aparato y junta las cuentas sin repetir', () => {
        const nombres = new Map([['u1', 'Maikel'], ['u2', 'Dainel']])
        const f = aFilaDeAparato({
            id: 'dis1', aparatoId: D.aparatoId, nombre: null, equipo: 'Samsung A14', plataforma: 'Android', vistoAt: hace(1),
            apps: [
                { ...app, clientId: 'crm-apk', version: '2.3.1', personas: [{ userId: 'u1', vistoAt: hace(5) }] },
                { ...app, clientId: 'delivery-apk', personas: [{ userId: 'u1', vistoAt: hace(2) }, { userId: 'u2', vistoAt: hace(3) }], rechazados: 2 },
            ],
        }, nombres, AHORA)
        expect(f.nombre).toBe('Samsung A14')
        expect(f.apps.map((a) => [a.nombre, a.marca])).toEqual([['CRM', 'funciona'], ['Reparto', 'atascado']])
        expect(f.cuentas.map((c) => c.persona)).toEqual(['Maikel', 'Dainel'])
        expect(f.cuentas[0].app).toBe('Reparto') // la vez más reciente de Maikel fue en Reparto
    })
})
