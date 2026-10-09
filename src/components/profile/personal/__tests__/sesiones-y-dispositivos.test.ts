/**
 * Sin DOM en este repositorio: la pantalla se vigila en el fuente (lo que se puede romper) y
 * los textos contra los dos catálogos. La lógica de verdad está probada en
 * `lib/__tests__/sesiones-de-la-persona.test.ts`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import es from '../../../../../messages/es.json'
import en from '../../../../../messages/en.json'

const leer = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '')
const COMPONENTE = sinComentarios(leer('src/components/profile/personal/sesiones-y-dispositivos.tsx'))
// Las funciones que ponen los textos viven en la lógica pura (y se EJECUTAN en sesiones-de-la-persona.test.ts).
const FUENTE = COMPONENTE + sinComentarios(leer('src/lib/sesiones-de-la-persona.ts'))

describe('la sección está en Mi cuenta', () => {
    it('profile-content la monta, y el resto de la página no depende de ella', () => {
        const contenido = sinComentarios(leer('src/components/profile/profile-content.tsx'))
        expect(contenido).toContain('<SesionesYDispositivos />')
        expect(contenido).toContain('<MiPerfilSecciones />')
    })
})

describe('qué hace cada botón', () => {
    it('la fila de la sesión ACTUAL sale (signOut, alcance web); las demás piden la revocación al servidor', () => {
        expect(FUENTE).toContain('authClient.signOut()')
        expect(FUENTE).toContain('f.actual ? void salirOAvisar() : void ejecutar({ accion: "una", id: f.id }, f.id)')
        // y sólo se va a la entrada si signOut no devolvió error (la lógica se ejecuta en sesiones-de-la-persona.test.ts)
        expect(COMPONENTE).toContain('salirDeLaWeb(() => authClient.signOut()')
    })
    it('«todas» sale después de cerrar (la propia sesión también cae), aunque sign-out ya no tenga sesión', () => {
        expect(FUENTE).toMatch(/orden\.accion === "todas"\) \{[\s\S]*?signOut\(\)\.catch\(\(\) => \{\}\);\s*return window\.location\.assign\("\/"\)/)
    })
    it('«las demás» y «todas» piden confirmación en un cajón, con el aviso de los dispositivos', () => {
        expect(FUENTE).toContain('setConfirmando("otras")')
        expect(FUENTE).toContain('setConfirmando("todas")')
        expect(FUENTE).toContain('<Panel')
        expect(FUENTE).toContain('confirmar.avisoDispositivos')
    })
    it('dos grupos y el conteo; la marca de la actual; tras cada acción se vuelve a leer la lista', () => {
        expect(FUENTE).toContain('t("conteo"')
        expect(FUENTE).toContain('"navegadores"')
        expect(FUENTE).toContain('"dispositivos"')
        expect(FUENTE).toContain('"estaSesion"')
        expect(FUENTE).toMatch(/setConfirmando\(null\);\s*await cargar\(\)/)
    })
    it('si la lista falla avisa dentro de su ficha (role=alert) y deja reintentar', () => {
        expect(FUENTE).toContain('role="alert"')
        expect(FUENTE).toContain('t("reintentar")')
    })
    it('no desborda a 390 px: filas que envuelven, botones a todo el ancho en móvil', () => {
        expect(FUENTE).toContain('flex-wrap')
        expect(FUENTE).toContain('w-full sm:w-auto')
        expect(FUENTE).toContain('break-words')
    })
})

describe('los textos', () => {
    const claves = (o: Record<string, unknown>, pre = ''): string[] =>
        Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' && v ? claves(v as Record<string, unknown>, pre + k + '.') : [pre + k]))

    it('es y en tienen EXACTAMENTE las mismas claves bajo «dispositivos» y «dispositivosArreglos»', () => {
        expect(claves(en.dispositivos).sort()).toEqual(claves(es.dispositivos).sort())
        expect(claves(en.dispositivosArreglos).sort()).toEqual(claves(es.dispositivosArreglos).sort())
    })
    it('toda clave que el componente pide existe, y el componente la pide de verdad', () => {
        const dic = new Set(claves(es.dispositivos))
        const usadas = [
            'titulo', 'ayuda', 'cargando', 'vacio', 'error', 'errorPista', 'reintentar', 'conteo',
            'estaSesion', 'esteDispositivo', 'app', 'appEn', 'nombre', 'sinNombre', 'ip', 'sinIp',
            'entroEl', 'ultimaActividad', 'aparatoAviso', 'cerrarEsta',
            'cerrarEsteAparato', 'cerrarOtras', 'cerrarTodas',
            'confirmar.tituloOtras', 'confirmar.cuerpoOtras', 'confirmar.tituloTodas', 'confirmar.cuerpoTodas',
            'confirmar.avisoDispositivos', 'confirmar.cancelar', 'confirmar.confirmarOtras', 'confirmar.confirmarTodas',
            'resultado.una', 'resultado.otras', 'resultado.noExiste', 'resultado.falloAccion',
            'grupo.navegadores', 'grupo.dispositivos',
        ]
        // Pedida de VERDAD: la clave entera, entre comillas, dentro de una llamada `t(...)` (o de sus ramas de un
        // ternario). Una subcadena no vale: `ip`, `app`, `una`, `otras`, `error` y `nombre` están dentro de otras palabras.
        const pedida = (k: string, t = 't') => new RegExp(`\\b${t}\\([^)]*["']${k.replace('.', '\\.')}["']`).test(FUENTE)
        for (const k of usadas) {
            expect(dic.has(k), `falta dispositivos.${k}`).toBe(true)
            if (k.startsWith('grupo.')) {
                expect(FUENTE, `el componente no pide ${k}`).toMatch(/t\(`grupo\.\$\{/)
                expect(FUENTE).toContain(`clave: "${k.slice(6)}"`)
            } else {
                expect(pedida(k), `el componente no pide t("${k}")`).toBe(true)
            }
        }
        expect(pedida('truncada', 'ta')).toBe(true)
    })
    it('el verificador de arriba SÍ distingue: no se deja engañar por subcadenas ni por literales sueltos', () => {
        const falso = (fuente: string, k: string) => new RegExp(`\\bt\\([^)]*["']${k}["']`).test(fuente)
        expect(falso('t("ip", { ip: f.ip })', 'ip')).toBe(true)
        expect(falso('{ ip: f.ip }', 'ip')).toBe(false) // t("ip") → f.ip
        expect(falso('"App de Reparto"', 'app')).toBe(false) // t("app") → "App"
        expect(falso('t("sinIp")', 'ip')).toBe(false) // 'ip' no es una subcadena de 'sinIp'
        expect(falso("t(f.tipo === 'aparato' ? 'cerrarEsteAparato' : 'cerrarEsta')", 'cerrarEsta')).toBe(true)
    })
    it('las claves «Aria» viejas ya no se usan (el nombre accesible es «texto visible: nombre»)', () => {
        expect(FUENTE).not.toMatch(/Aria["']/)
    })
    it('el aviso de los dispositivos dice que el trabajo sin subir no se pierde', () => {
        expect(es.dispositivos.confirmar.avisoDispositivos).toMatch(/sin subir no se pierde/)
        expect(es.dispositivos.aparatoAviso).toMatch(/15 minutos/)
    })
})

describe('accesibilidad y avisos', () => {
    it('una sola región role="status" (carga y resultado); los errores van aparte, en role="alert"', () => {
        expect(COMPONENTE.match(/role="status"/g)).toHaveLength(1)
        expect(COMPONENTE).not.toMatch(/role=\{[^}]*status/)
    })
    it('la lista no repite el nombre del grupo: el <h3> ya lo dice, sin aria-label en el <ul>', () => {
        expect(COMPONENTE).not.toMatch(/<ul[^>]*aria-label/)
    })
    it('«Cerrar las demás» se deshabilita con hayOtras(lista) (la lógica se ejecuta en sesiones-de-la-persona.test.ts)', () => {
        expect(COMPONENTE).toContain('isDisabled={!hayOtrasSesiones || ocupado !== null}')
        expect(COMPONENTE).toContain('hayOtras(lista)')
    })
    it('el aviso de los dispositivos sólo sale si hay alguno; la lista truncada lleva su línea', () => {
        expect(COMPONENTE).toMatch(/aparatos\.length > 0 && <p[^>]*>\{t\("confirmar\.avisoDispositivos"\)\}/)
        expect(COMPONENTE).toMatch(/truncada && <p[^>]*>\{ta\("truncada"\)\}/)
    })
})
