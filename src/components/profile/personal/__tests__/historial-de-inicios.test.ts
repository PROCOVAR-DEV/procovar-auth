/**
 * Sin DOM en este repositorio: el componente se vigila en el fuente. Lo que no puede pasar:
 * que pida el historial de otra persona, que arrastre Prisma al navegador o que use una clave
 * de mensajes que no existe (next-intl no revienta, pinta la ruta de la clave).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import es from '../../../../../messages/es.json'
import en from '../../../../../messages/en.json'

const bruto = readFileSync(path.join(process.cwd(), 'src/components/profile/personal/historial-de-inicios.tsx'), 'utf8')
const fuente = bruto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

describe('historial-de-inicios.tsx', () => {
    it('lo pide a /api/user/historial, sin mandar quién es', () => {
        expect(fuente).toContain('/api/user/historial')
        expect(fuente).not.toMatch(/userId|user\.id/)
    })

    it('de lib sólo importa tipos del historial (nada de Prisma en el navegador)', () => {
        expect(fuente).toContain('import type { FilaDeInicio, PaginaDeInicios } from "@/lib/historial-de-inicios"')
        expect(fuente).not.toMatch(/import (?!type)[^;]*@\/lib\/(prisma|audit|historial-de-inicios)/)
    })

    it('toda clave t("…") existe en es y en en', () => {
        const claves = [...fuente.matchAll(/\bt\(\s*"([\w.]+)"/g)].map((m) => m[1])
        expect(claves.length).toBeGreaterThan(10)
        for (const mensajes of [es, en] as Record<string, Record<string, unknown>>[]) {
            for (const c of claves) expect(mensajes.historial[c], `falta historial.${c}`).toBeTypeOf('string')
        }
    })

    it('tiene estado vacío, de error y "Ver más" sólo si hay siguiente', () => {
        for (const c of ['t("vacio")', 't("error")', 't("errorMas")', 't("verMas")']) expect(fuente).toContain(c)
        expect(fuente).toMatch(/\{siguiente && Array\.isArray\(filas\) && \(/)
    })

    it('la fecha va en el idioma de quien mira y las IPv6 largas no desbordan', () => {
        expect(fuente).toContain('new Intl.DateTimeFormat(locale')
        expect(fuente).toContain('break-all')
    })
})
