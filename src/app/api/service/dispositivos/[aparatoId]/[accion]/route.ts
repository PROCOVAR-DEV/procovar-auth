/**
 * Lo que una APLICACIÓN hace con SUS aparatos desde sus propias pantallas (el CRM conserva su alta y sus pantallas de aparatos;
 * los datos viven aquí). Service-auth, por la red interna, con el MISMO alcance por credencial que la lista
 * (`dispositivos:<clientId>`, ver `../../route.ts`): solo aparatos de su aplicación.
 *
 *   POST /api/service/dispositivos/{aparatoId}/bloquear     cierra su sesión Y no vuelve a entrar con ese `X-Aparato-Id`
 *   POST /api/service/dispositivos/{aparatoId}/desbloquear  le deja volver
 *   POST /api/service/dispositivos/{aparatoId}/nombre       { "nombre": "Samsung de Palma" | null }   (1–80 car.; vacío/null = quitarlo)
 *       [?app=crm]  solo hace falta si la credencial tiene VARIAS aplicaciones
 *
 *   200 { ok: true, estado: "activo" | "bloqueado" }
 *   400 { error: 'invalid_json' | 'invalid_body' | 'app_invalida' | 'app_obligatoria' }
 *   403 { error: 'sin_permiso_de_dispositivos' | 'app_no_permitida' }
 *   404 { error: 'not_found' }   no existe, o es de OTRA aplicación (no se distingue: no se cuenta qué aparatos hay)
 *
 * Hace EXACTAMENTE lo que haría un administrador en el panel de Accesos (`lib/dispositivos-acciones.ts`): cierra la cadena de
 * refresh, queda en la auditoría (con el servicio que lo pidió) y AVISA por el canal de su aplicación
 * (`procovar:auth:dispositivos:<clientId>`, motivo `bloqueado` / `desbloqueado` / `renombrado`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth, type ServiceAuthContext } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import { appDeLaPeticion, appsPermitidas } from '@/lib/dispositivos-lista';
import { esUuidCualquiera } from '@/lib/dispositivos';
import { aplicarOrden, type OrdenDeDispositivo } from '@/lib/dispositivos-acciones';
import { desdeDondePide } from '@/lib/apk-tokens';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };
const json = (cuerpo: object, estado = 200) => NextResponse.json(cuerpo, { status: estado, headers: SIN_CACHE });

const ACCIONES = ['bloquear', 'desbloquear', 'nombre'] as const;
const NombreSchema = z.object({ nombre: z.string().max(200).nullable() });

export const POST = withServiceAuth(
    async (req: NextRequest, ctx: ServiceAuthContext) => {
        const url = new URL(req.url);
        // `withServiceAuth` no pasa los parámetros de la ruta: se leen del camino (…/dispositivos/{aparatoId}/{accion}).
        const m = /\/dispositivos\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
        const aparatoId = decodeURIComponent(m?.[1] ?? '').trim().toLowerCase();
        const accion = m?.[2] as (typeof ACCIONES)[number] | undefined;
        if (!m || !esUuidCualquiera(aparatoId) || !accion || !ACCIONES.includes(accion)) return json({ error: 'not_found' }, 404);

        const elegida = appDeLaPeticion(url.searchParams.get('app'), appsPermitidas(ctx.client.scopes));
        if (!elegida.ok) return json({ error: elegida.error }, elegida.estado);

        let orden: OrdenDeDispositivo;
        if (accion === 'nombre') {
            let cuerpo: unknown;
            try {
                cuerpo = await req.json();
            } catch {
                return json({ error: 'invalid_json' }, 400);
            }
            const n = NombreSchema.safeParse(cuerpo);
            if (!n.success) return json({ error: 'invalid_body' }, 400);
            orden = { accion: 'nombre', nombre: n.data.nombre };
        } else {
            orden = { accion };
        }

        try {
            // La aplicación va en la BÚSQUEDA: un aparato de otra aplicación NO se encuentra (404), no se rechaza con un 403 que lo delataría.
            const crudo = await prisma.dispositivoApp.findUnique({
                where: { clientId_aparatoId: { clientId: elegida.app, aparatoId } },
                select: { id: true, dispositivoId: true, clientId: true, aparatoId: true, userId: true, familyId: true, bloqueadoAt: true },
            });
            if (!crudo) return json({ error: 'not_found' }, 404);
            const fila = crudo;

            const r = await aplicarOrden(fila, orden, { id: ctx.client.clientId, via: 'servicio' }, desdeDondePide(req.headers));
            if (!r.ok) return json({ error: r.error }, r.estado);

            const bloqueado = accion === 'bloquear' ? true : accion === 'desbloquear' ? false : !!fila.bloqueadoAt;
            return json({ ok: true, estado: bloqueado ? 'bloqueado' : 'activo' });
        } catch (e) {
            logger.error('[service/dispositivos] error', { error: (e as Error).message, accion });
            return json({ error: 'internal_error' }, 500);
        }
    },
    { allowLegacyBearer: false }
);
