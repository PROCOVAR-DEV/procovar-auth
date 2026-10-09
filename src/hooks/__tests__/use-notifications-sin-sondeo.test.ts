/**
 * Jose no quiere sondeo («un reguero de peticiones»). Sin DOM en este repositorio, se
 * vigila en el fuente del hook y de la campana, que es donde se puede romper: nada de
 * `setInterval`, nada de `EventSource`, nada de `/api/events`, y lo que corre fuera de
 * un render llama a la versión MÁS RECIENTE de la carga (por ref), no a la de la página vieja.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const leer = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const HOOK = sinComentarios(leer('src/hooks/use-notifications.ts'))
const CAMPANA = sinComentarios(leer('src/components/layout/navbar/notification-bell.tsx'))

describe('use-notifications: sin sondeo', () => {
    it('no hay intervalo, ni EventSource, ni /api/events', () => {
        for (const prohibido of ['setInterval', 'POLL_MS', 'EventSource', '/api/events', 'setTimeout']) {
            expect(HOOK).not.toContain(prohibido)
        }
    })

    it('refresca al volver a la pestaña: foco y visibilidad', () => {
        expect(HOOK).toContain('"focus"')
        expect(HOOK).toContain('"visibilitychange"')
    })

    it('el efecto en vivo depende solo de `live`: cambiar de página no reconecta', () => {
        expect(HOOK).toMatch(/\},\s*\[live\]\)/)
    })
})

describe('use-notifications: no captura la página vieja', () => {
    it('las acciones y el foco llaman a la última carga por ref, con deps vacías', () => {
        expect(HOOK).toContain('loadRef.current()')
        // `load` solo es dependencia del efecto que actualiza el ref y del de montaje: ni
        // `act`, ni `markAllRead`, ni `archiveAllRead` la capturan (se quedarían con la página vieja).
        expect(HOOK.match(/\[load\]/g)).toHaveLength(2)
        expect(HOOK).not.toContain('[refresh]')
    })

    it('`refresh` es estable: lo devuelve el hook con useCallback([])', () => {
        expect(HOOK).toMatch(/const refresh = useCallback\(\(\) => loadRef\.current\(\), \[\]\)/)
    })
})

describe('la campana', () => {
    it('refresca al abrir el panel, desde la primera página, sin segunda petición', () => {
        expect(CAMPANA).toContain('const abrir = () =>')
        expect(CAMPANA).toMatch(/if \(page === 1\) void refresh\(\);\s*else setPage\(1\);/)
        expect(CAMPANA).toContain('open ? cerrar() : abrir()')
    })

    it('cerrar no cambia de página (cerrado no hay ninguna petición por detrás)', () => {
        expect(CAMPANA).toContain('const cerrar = () => setOpen(false);')
        // setPage solo en `abrir` y en la paginación del panel.
        expect(CAMPANA.match(/setPage\(/g)).toHaveLength(1)
    })
})
