/**
 * «Marcar todo como leído» en el centro de avisos (se había perdido al reducir la campana
 * al panel emergente). Sin DOM: se vigila el fuente de la pantalla y que sus textos existan
 * en los dos idiomas, y que las claves viejas de la campana ya no estén huérfanas.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import es from '../../../../../../messages/es.json'
import en from '../../../../../../messages/en.json'

const leer = (...p: string[]) => readFileSync(path.join(process.cwd(), ...p), 'utf8')
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const PAGINA = sinComentarios(leer('src/app/(user)/profile/notifications/page.tsx'))

describe('centro de avisos: marcar todo como leído', () => {
    it('tiene el botón, deshabilitado mientras marca, y solo si hay algo sin leer', () => {
        expect(PAGINA).toContain('markAllRead')
        expect(PAGINA).toContain('unreadIds.length > 0')
        expect(PAGINA).toContain('isDisabled={markingAll}')
        expect(PAGINA).toContain('avisosPanel.marcarTodo')
        expect(PAGINA).toContain('avisosPanel.marcandoTodo')
    })

    it('marca los que isUnread dice que están sin leer', () => {
        expect(PAGINA).toContain('notifications.filter(isUnread)')
    })

    it('si alguno falla, lo dice (role="alert")', () => {
        expect(PAGINA).toContain('failedMarks > 0')
        expect(PAGINA).toContain('role="alert"')
        expect(PAGINA).toContain('avisosPanel.marcarTodoError')
    })
})

describe('los textos', () => {
    it('existen en es y en', () => {
        for (const m of [es, en] as Array<{ avisosPanel: Record<string, string> }>) {
            for (const k of ['marcarTodo', 'marcandoTodo', 'marcarTodoError']) expect(m.avisosPanel[k]).toBeTruthy()
        }
    })

    it('las claves nav.* de la campana vieja ya no están (nadie las usa)', () => {
        for (const m of [es, en] as Array<{ nav: Record<string, string> }>) {
            for (const k of ['notifications', 'notificationsAria', 'markAllRead', 'noNotifications', 'noNotificationsHint', 'manageNotifications']) {
                expect(m.nav).not.toHaveProperty(k)
            }
        }
    })
})
