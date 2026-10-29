/**
 * POST /api/admin/firma-apk, de punta a punta con las herramientas de verdad y un keystore de juguete (la "huella de la casa"
 * se sustituye por la del juguete SOLO aquí). Lo que se ata: quién puede, de dónde, qué se rechaza y con qué código, que la
 * APK entregada la verifica apksigner, que queda el historial y la auditoría, y que nada de la clave ni de rutas sale por la API.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest, NextResponse } from 'next/server';

const m = vi.hoisted(() => ({
    admin: vi.fn(),
    audit: vi.fn(),
    crear: vi.fn(),
    almacen: vi.fn(),
    puede: vi.fn(),
    huella: { valor: '' },
}));
vi.mock('@/lib/require-admin', () => ({ requireSystemAdmin: m.admin }));
vi.mock('@/lib/permiso-de-firma', () => ({ puedeFirmarApk: m.puede }));
vi.mock('@/lib/audit', () => ({ audit: m.audit }));
vi.mock('@/lib/prisma', () => ({ prisma: { firmaApk: { create: m.crear } } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/firma-apk-clave', async (original) => ({ ...(await original<typeof import('@/lib/firma-apk-clave')>()), cargarAlmacen: m.almacen }));
vi.mock('@/lib/firma-apk', async (original) => {
    const real = await original<typeof import('@/lib/firma-apk')>();
    return { ...real, firmarArchivo: (op: Parameters<typeof real.firmarArchivo>[0]) => real.firmarArchivo({ ...op, huellaEsperada: m.huella.valor }) };
});

import { POST } from '../route';
import { crearKeystoreDeJuguete, herramientas, usarHerramientas, type KeystoreDeJuguete } from '@/lib/__tests__/helpers/herramientas-de-firma';

const FIXTURES = path.join(process.cwd(), 'src/lib/__tests__/fixtures');
const URL_FIRMA = 'http://localhost:3500/api/admin/firma-apk';
const ADMIN = { user: { id: 'u-admin', email: 'a@b.c', isSystemAdmin: true }, session: { id: 's', userId: 'u-admin', expiresAt: new Date() } };

const pedido = (cuerpo: Buffer | null, cabeceras: Record<string, string> = {}) =>
    new NextRequest(URL_FIRMA, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', origin: 'http://localhost:3500', 'x-firma-app': 'delivery-apk', ...cabeceras },
        body: cuerpo ? new Uint8Array(cuerpo) : null,
    });

const temporales = () => readdirSync(tmpdir()).filter((f) => f.startsWith('procovar-firma-'));

describe.skipIf(!herramientas().completas)('la ruta de firma', () => {
    let juguete: KeystoreDeJuguete;
    let raiz: string;
    let reparto: Buffer;
    let ajena: Buffer;

    beforeAll(async () => {
        usarHerramientas();
        process.env.SERVICE_AUTH_SECRET = 'prueba-de-ruta-'.repeat(4);
        raiz = await mkdtemp(path.join(tmpdir(), 'prueba-ruta-'));
        juguete = crearKeystoreDeJuguete(raiz);
        m.huella.valor = juguete.huella;
        reparto = await readFile(path.join(FIXTURES, 'reparto-sin-firmar.apk'));
        ajena = await readFile(path.join(FIXTURES, 'ajena-sin-firmar.apk'));
    });
    afterAll(async () => {
        await rm(raiz, { recursive: true, force: true });
    });
    beforeEach(async () => {
        vi.clearAllMocks();
        m.admin.mockResolvedValue(ADMIN);
        m.puede.mockResolvedValue(true);
        m.crear.mockResolvedValue({});
        m.almacen.mockResolvedValue({
            huella: juguete.huella,
            alias: juguete.alias,
            almacen: { keystoreB64: (await readFile(juguete.ruta)).toString('base64'), claveAlmacen: juguete.claveAlmacen, claveAlias: juguete.claveAlias },
        });
    });

    it('un administrador sube una APK de Reparto y recibe la firmada, verificada por apksigner', async () => {
        const antes = temporales();
        const r = await POST(pedido(reparto));
        expect(r.status).toBe(200);
        expect(r.headers.get('content-type')).toBe('application/vnd.android.package-archive');
        expect(r.headers.get('content-disposition')).toBe('attachment; filename="reparto-1.2.3-firmada.apk"');
        const cuerpo = Buffer.from(await r.arrayBuffer());
        expect(r.headers.get('x-sha256')).toBe(createHash('sha256').update(cuerpo).digest('hex'));

        const f = path.join(raiz, 'entregada.apk');
        await writeFile(f, cuerpo);
        const salida = execFileSync(process.env.APKSIGNER!, ['verify', '--verbose', '--print-certs', f], { stdio: 'pipe' }).toString();
        expect(salida).toMatch(/v2 scheme \(APK Signature Scheme v2\): true/);
        expect(salida).toMatch(/v3 scheme \(APK Signature Scheme v3\): true/);
        expect(salida.toLowerCase()).toContain(juguete.huella);

        // Historial + auditoría: quién, cuándo (createdAt), app, versión, sha256 del resultado.
        expect(m.crear).toHaveBeenCalledOnce();
        expect(m.crear.mock.calls[0][0].data).toMatchObject({ clientId: 'delivery-apk', paquete: 'cloud.procovar.reparto', versionName: '1.2.3', versionCode: '45', sha256Salida: r.headers.get('x-sha256'), userId: 'u-admin' });
        expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'apk.firmar', userId: 'u-admin', meta: expect.objectContaining({ versionName: '1.2.3', sha256Salida: r.headers.get('x-sha256') }) }));

        // Nada de la clave en ningún sitio que salga de aquí, y no queda nada en /tmp.
        const visible = JSON.stringify([m.audit.mock.calls, m.crear.mock.calls, [...r.headers.entries()]]);
        for (const secreto of [juguete.claveAlmacen, juguete.claveAlias]) expect(visible).not.toContain(secreto);
        expect(temporales()).toEqual(antes);
    });

    it('una APK de otro paquete: 422 paquete_no_permitido, auditado como rechazado, sin rutas del servidor y sin registro de firma', async () => {
        const antes = temporales();
        const r = await POST(pedido(ajena));
        expect(r.status).toBe(422);
        const j = (await r.json()) as { error: string; mensaje: string };
        expect(j.error).toBe('paquete_no_permitido');
        expect(JSON.stringify(j)).not.toMatch(/\/tmp|procovar-firma|\/home|node_modules/);
        expect(m.crear).not.toHaveBeenCalled();
        expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'apk.firmar_rechazada', meta: { motivo: 'paquete_no_permitido' } }));
        expect(temporales()).toEqual(antes);
    });

    it('lo que no es una APK: 422 apk_invalida', async () => {
        const r = await POST(pedido(Buffer.from('esto no es un APK '.repeat(20))));
        expect(r.status).toBe(422);
        expect(((await r.json()) as { error: string }).error).toBe('apk_invalida');
    });

    it('aplicación desconocida o ausente: 400, y no se lee el cuerpo', async () => {
        for (const app of ['otra-apk', '', '__proto__']) {
            const r = await POST(pedido(reparto, { 'x-firma-app': app }));
            expect(r.status).toBe(400);
            expect(((await r.json()) as { error: string }).error).toBe('app_desconocida');
        }
        expect(m.almacen).not.toHaveBeenCalled();
    });

    it('un cuerpo que ya DECLARA pasar de 120 MB se rechaza (413) sin empezar a leerlo', async () => {
        const r = await POST(pedido(reparto, { 'content-length': String(121 * 1024 * 1024) }));
        expect(r.status).toBe(413);
        expect(m.almacen).not.toHaveBeenCalled();
    });

    it('sin clave importada: 409 sin_clave', async () => {
        const { ErrorDeFirma } = await import('@/lib/firma-apk-error');
        m.almacen.mockRejectedValue(new ErrorDeFirma('sin_clave'));
        const r = await POST(pedido(reparto));
        expect(r.status).toBe(409);
        expect(((await r.json()) as { error: string }).error).toBe('sin_clave');
    });

    it('si no se puede dejar constancia en el historial, no se entrega la APK (500)', async () => {
        m.crear.mockRejectedValue(new Error('la base no contesta'));
        const r = await POST(pedido(reparto));
        expect(r.status).toBe(500);
        expect(await r.json()).toEqual({ error: 'internal_error' });
    });

    it('quien no es administrador global no firma nada: la respuesta del guardián se devuelve tal cual', async () => {
        m.admin.mockResolvedValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
        const r = await POST(pedido(reparto));
        expect(r.status).toBe(403);
        expect(m.almacen).not.toHaveBeenCalled();
        expect(m.crear).not.toHaveBeenCalled();
    });

    it('un administrador global SIN el permiso auth.firma_apk tampoco firma: 403, auditado y sin tocar la clave', async () => {
        m.puede.mockResolvedValue(false)
        const r = await POST(pedido(reparto))
        expect(r.status).toBe(403)
        expect(m.puede).toHaveBeenCalledWith('u-admin')
        expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'apk.firmar_denegada', userId: 'u-admin' }))
        expect(m.almacen).not.toHaveBeenCalled()
        expect(m.crear).not.toHaveBeenCalled()
    });

    it('desde otro origen: 403; con Content-Type de formulario o JSON: 415', async () => {
        expect((await POST(pedido(reparto, { origin: 'https://otra.procovar.cloud' }))).status).toBe(403);
        expect((await POST(pedido(reparto, { 'content-type': 'multipart/form-data; boundary=x' }))).status).toBe(415);
        expect((await POST(pedido(reparto, { 'content-type': 'application/json' }))).status).toBe(415);
        expect((await POST(pedido(reparto, { 'content-type': 'text/plain' }))).status).toBe(415);
        expect(m.admin).not.toHaveBeenCalled();
    });
});
