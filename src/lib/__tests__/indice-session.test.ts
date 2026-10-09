/**
 * `session` tiene índice por `userId`, en el esquema Y en una migración (sin deriva).
 *
 * Todo lo que pregunta por las sesiones de UNA persona (panel de dispositivos, cerrar todas, baja)
 * recorría la tabla entera. El esquema y el SQL tienen que decir lo mismo: el nombre de Prisma para
 * `@@index([userId])` en el modelo mapeado a "session" es `session_userId_idx`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const raiz = path.resolve(__dirname, '../../../prisma');
const esquema = readFileSync(path.join(raiz, 'schema.prisma'), 'utf8');
const modelo = (nombre: string) => esquema.match(new RegExp(`model ${nombre} \\{[\\s\\S]*?\\n\\}`))![0];
const migraciones = readdirSync(path.join(raiz, 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readFileSync(path.join(raiz, 'migrations', d.name, 'migration.sql'), 'utf8'));

describe('índice de session por userId', () => {
    it('el modelo Session declara @@index([userId]) y sigue mapeado a "session"', () => {
        const session = modelo('Session');
        expect(session).toMatch(/@@index\(\[userId\]\)/);
        expect(session).toMatch(/@@map\("session"\)/);
    });

    it('hay una migración que lo crea, repetible (IF NOT EXISTS) y con el nombre que Prisma genera', () => {
        const sql = migraciones.filter((m) => /"session_userId_idx"/.test(m));
        expect(sql).toHaveLength(1);
        expect(sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"\("userId"\);/);
    });

    it('refresh_token ya tenía índice por expiresAt (la purga por lotes lo aprovecha)', () => {
        expect(modelo('RefreshToken')).toMatch(/@@index\(\[expiresAt\]\)/);
    });
});
