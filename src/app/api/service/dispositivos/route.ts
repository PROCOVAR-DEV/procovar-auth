/**
 * Los DISPOSITIVOS de una aplicación. Service-auth, por la red interna (como `/api/service/almacenes`).
 *
 * Accesos es la fuente de la identidad del aparato (`docs/dispositivos.md`); la aplicación guarda su ficha local con el
 * MISMO `aparatoId` y lee de aquí si existe, de quién es, versión, plataforma y si está bloqueado.
 *
 * **LA APLICACIÓN SALE DE QUIÉN LLAMA.** La credencial de servicio lleva en sus `scopes` `dispositivos:<clientId>` (p. ej.
 * `dispositivos:crm-apk`): solo ve esos aparatos. Sin ese scope, 403; con `?app=` de otra aplicación, 403; el `Bearer`
 * antiguo y el comodín `*` no valen. El CRM no ve nunca un aparato de Reparto.
 *
 * GET ?app=crm                   OPCIONAL si la credencial solo tiene UNA app (`reparto` = `delivery-apk`, `crm` = `crm-apk`).
 *     &sucursal=STG              solo los de esa sucursal (el código).
 *     &desde=<ISO 8601>          solo los cambiados DESPUÉS de esa hora (para ponerse al día sin bajarlo todo).
 *     &limite=500                por tanda (máx. 2000).
 *     &despues=<cursor>          el `siguiente` de la tanda anterior.
 *
 *   200 { dispositivos: [...], truncado: boolean, siguiente: string | null, hasta: ISO }
 *   400 { error: 'app_invalida' | 'app_obligatoria' | 'desde_invalido' | 'cursor_invalido' }
 *   403 { error: 'sin_permiso_de_dispositivos' | 'app_no_permitida' }
 *
 * `truncado: true` = hay más: se pide la tanda siguiente con `despues=<siguiente>`. **Una aplicación que sincroniza su lista
 * NO puede dar por buena una tanda truncada** (el mismo fallo de los 2.000 clientes: CLAUDE.md de delivery-logistica §3).
 *
 * POST { dispositivos: [{ aparatoId, userId, plataforma?, nombre?, version?, sucursal?, primeraVez?, ultimaVez? }] }
 *   IMPORTA aparatos que la aplicación ya tenía antes de existir este registro (máx. 100 por llamada). Es idempotente y NO
 *   pisa: si el aparato ya está, queda como está. El `aparatoId` puede ser cualquier UUID (el del CRM era v4: de antes del
 *   cambio a v7); la `app` es la de la credencial. 200 { resultados: [{ aparatoId, resultado }] } con
 *   `resultado`: `creado` | `ya_existia` | `persona_inexistente` | `invalido`.
 *
 * El aviso en vivo de un cambio va por Redis, UN CANAL POR APLICACIÓN (`procovar:auth:dispositivos:<clientId>`,
 * `lib/eventos-de-dispositivos.ts`); puede perderse, y esta lista es la fuente de verdad: se consulta al arrancar y al
 * reconectar.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { withServiceAuth, type ServiceAuthContext } from '@/lib/with-service-auth';
import { prisma } from '@/lib/prisma';
import { logger } from '@/lib/logger';
import {
    aServicio,
    appDeLaPeticion,
    appsPermitidas,
    codificarCursor,
    decodificarCursor,
    fechaOpcional,
    limiteDe,
} from '@/lib/dispositivos-lista';
import { esUuidCualquiera, limpiarTexto } from '@/lib/dispositivos';

export const dynamic = 'force-dynamic';

const SIN_CACHE = { 'Cache-Control': 'no-store' };
const error = (estado: number, codigo: string) => NextResponse.json({ error: codigo }, { status: estado, headers: SIN_CACHE });

/** Sin `Bearer` antiguo: ese entra con `*` y vería todas las aplicaciones. */
const OPCIONES = { allowLegacyBearer: false };

export const GET = withServiceAuth(async (req: NextRequest, ctx: ServiceAuthContext) => {
    const q = new URL(req.url).searchParams;

    const elegida = appDeLaPeticion(q.get('app'), appsPermitidas(ctx.client.scopes));
    if (!elegida.ok) return error(elegida.estado, elegida.error);
    const clientId = elegida.app;

    const desdeCrudo = q.get('desde');
    const desde = fechaOpcional(desdeCrudo);
    if (desdeCrudo && !desde) return error(400, 'desde_invalido');

    const cursorCrudo = q.get('despues');
    const cursor = decodificarCursor(cursorCrudo);
    if (cursorCrudo && !cursor) return error(400, 'cursor_invalido');

    const sucursal = q.get('sucursal')?.trim().toUpperCase() || null;
    const limite = limiteDe(q.get('limite'));
    const hasta = new Date();

    const filtros: Record<string, unknown>[] = [{ clientId }];
    if (sucursal) filtros.push({ sucursal });
    if (desde) filtros.push({ updatedAt: { gt: desde } });
    // El cursor por (updatedAt, id): lo que va DESPUÉS de la última fila servida, sin saltar ni repetir las que comparten hora.
    if (cursor) {
        filtros.push({
            OR: [{ updatedAt: { gt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, id: { gt: cursor.id } }],
        });
    }

    // Se pide UNA FILA DE MÁS: la forma barata de distinguir «caben justo» de «hay más».
    const filas = await prisma.dispositivo.findMany({
        where: { AND: filtros },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: limite + 1,
    });
    const truncado = filas.length > limite;
    const servidas = truncado ? filas.slice(0, limite) : filas;

    return NextResponse.json(
        {
            dispositivos: servidas.map(aServicio),
            truncado,
            siguiente: truncado ? codificarCursor(servidas[servidas.length - 1]) : null,
            hasta: hasta.toISOString(),
        },
        { headers: SIN_CACHE }
    );
}, OPCIONES);

const FechaOpc = z.string().refine((v) => Number.isFinite(Date.parse(v))).optional();
const Importado = z.object({
    aparatoId: z.string(),
    userId: z.string().min(1).max(128),
    plataforma: z.string().max(40).nullish(),
    nombre: z.string().max(200).nullish(),
    version: z.string().max(32).nullish(),
    sucursal: z.string().max(10).nullish(),
    primeraVez: FechaOpc,
    ultimaVez: FechaOpc,
});
const ImportacionSchema = z.object({ dispositivos: z.array(z.unknown()).min(1).max(100) });

type Resultado = 'creado' | 'ya_existia' | 'persona_inexistente' | 'invalido';

export const POST = withServiceAuth(async (req: NextRequest, ctx: ServiceAuthContext) => {
    // La aplicación de la credencial: la única que tiene. Con varias hay que decir cuál (`?app=`).
    const elegida = appDeLaPeticion(new URL(req.url).searchParams.get('app'), appsPermitidas(ctx.client.scopes));
    if (!elegida.ok) return error(elegida.estado, elegida.error);
    const clientId = elegida.app;

    let cuerpo: unknown;
    try {
        cuerpo = await req.json();
    } catch {
        return error(400, 'invalid_json');
    }
    const lote = ImportacionSchema.safeParse(cuerpo);
    if (!lote.success) return error(400, 'invalid_body');

    const resultados: { aparatoId: string; resultado: Resultado }[] = [];
    for (const crudo of lote.data.dispositivos) {
        const idCrudo = typeof (crudo as { aparatoId?: unknown })?.aparatoId === 'string' ? (crudo as { aparatoId: string }).aparatoId : '';
        const d = Importado.safeParse(crudo);
        const aparatoId = idCrudo.trim().toLowerCase();
        if (!d.success || !esUuidCualquiera(aparatoId)) {
            resultados.push({ aparatoId: idCrudo.slice(0, 64), resultado: 'invalido' });
            continue;
        }
        const persona = await prisma.user.findUnique({ where: { id: d.data.userId }, select: { id: true } });
        if (!persona) {
            resultados.push({ aparatoId, resultado: 'persona_inexistente' });
            continue;
        }
        const existe = await prisma.dispositivo.findUnique({
            where: { clientId_aparatoId: { clientId, aparatoId } },
            select: { id: true },
        });
        if (existe) {
            resultados.push({ aparatoId, resultado: 'ya_existia' });
            continue;
        }
        const primera = d.data.primeraVez ? new Date(d.data.primeraVez) : new Date();
        const ultima = d.data.ultimaVez ? new Date(d.data.ultimaVez) : primera;
        await prisma.dispositivo.create({
            data: {
                userId: d.data.userId,
                clientId,
                aparatoId,
                plataforma: limpiarTexto(d.data.plataforma, 40),
                version: limpiarTexto(d.data.version, 32),
                // El modelo del aparato es el nombre que traía la aplicación: es `equipo`, no el nombre que un administrador pone.
                equipo: limpiarTexto(d.data.nombre, 80),
                sucursal: d.data.sucursal ? d.data.sucursal.trim().toUpperCase() : null,
                primeraVez: primera,
                vistoAt: ultima,
            },
        });
        resultados.push({ aparatoId, resultado: 'creado' });
    }
    logger.info('[dispositivos] importación', {
        app: clientId,
        servicio: ctx.client.clientId,
        creados: resultados.filter((r) => r.resultado === 'creado').length,
        total: resultados.length,
    });
    return NextResponse.json({ resultados }, { headers: SIN_CACHE });
}, OPCIONES);
