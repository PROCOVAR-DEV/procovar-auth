/**
 * La puerta de entrada por token: el par acceso + refresh que usa la APK.
 *
 * Auth ya sabía identificar de dos formas, y ninguna le sirve a una aplicación
 * instalada en un teléfono:
 *
 *  - el **login por redirección**, que acaba en una cookie de navegador;
 *  - la **firma HMAC entre servidores**, que exige llevar una clave dentro.
 *
 * Una APK **se descompila**. La clave de firma dentro del teléfono deja a
 * cualquiera hacerse pasar por delivery ante auth, así que el aparato no lleva
 * ningún secreto de aplicación: manda usuario y contraseña por HTTPS y recibe un
 * par de tokens. El razonamiento completo está en
 * `delivery-logistica/docs/identidad.md`, y esto NO sustituye a las otras dos
 * puertas — se añade al lado.
 *
 * ## Las tres reglas
 *
 * 1. **El acceso dura 15 minutos y no se revoca.** Va en cada petición y se
 *    verifica sin preguntarle a nadie, así que una vez emitido vale hasta que
 *    caduca. Quince minutos acotan a casi nada la ventana de uno robado.
 * 2. **El refresh es de un solo uso y se sustituye entero.** Cada renovación
 *    devuelve un par NUEVO, los dos.
 * 3. **Un refresh que vuelve es un robo — pasada la ventana de gracia.** El
 *    aparato legítimo ya tiene el siguiente, así que quien presenta el viejo
 *    tiene una copia: se revocan TODAS las sesiones de esa cuenta —no sólo la de
 *    ese aparato— porque no se sabe cuál de los dos es el ladrón. Lo único que
 *    se exceptúa es el refresh que vuelve **en los segundos siguientes** a
 *    haberse gastado, que no es un ladrón sino una respuesta que se perdió por
 *    el camino: ver `SEGUNDOS_DE_GRACIA`, que cuenta el día que esto costó.
 * 4. **La gracia se concede UNA vez por fila, y punto.** Cada concesión abre una
 *    rama nueva que vive 30 días; una gracia sin tope deja que un solo refresh
 *    robado abra las que quiera y apague la detección de esa cuenta un mes. El
 *    tope es la columna `graceUsedAt`, reclamada con el mismo `updateMany`
 *    condicionado que `usedAt`. Ver `reclamarLaGracia`.
 *
 * ## Por qué el acceso va firmado con `JWT_SECRET` y no con la JWKS
 *
 * Quien lo lee es la API del reparto, que verifica a mano con `crypto/hmac` y
 * tiene el algoritmo FIJADO en el código: un token que diga `RS256` lo rechaza
 * antes de mirar nada (`api/internal/auth/auth.go`). Firmar esto con la clave
 * asimétrica de `/api/auth/sign` daría un token impecable que ningún servicio de
 * Procovar aceptaría. `JWT_SECRET` es el mismo nombre que ya usan la API del
 * reparto y PEDIDO, y **su valor lo pone Dokploy**: aquí no hay ni respaldo ni
 * valor por defecto, porque un secreto de desarrollo colado en producción firma
 * tokens que abren la sucursal entera.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { signJwt } from '@/lib/jwt';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { publicarSesionCerrada } from '@/lib/eventos-de-sesion';
import { rolesFirmados, rolPrincipal } from '@/lib/roles-de-la-persona';
import { accesoDe } from '@/lib/aplicaciones-visibles';
import { ComprobacionNoDisponible, LLAVE_DEL_CLIENTE, comprobarEntrada, entradasDe } from '@/lib/puerta-de-entrada';

/** 15 minutos. El mismo valor que usa `call-center-board`. */
export const SEGUNDOS_ACCESO = 15 * 60;
/** 30 días. Sólo muerde a quien pasa ese tiempo entero sin conectarse ni una vez. */
export const SEGUNDOS_REFRESH = 30 * 24 * 60 * 60;

/**
 * LA VENTANA DE GRACIA. Un refresh recién gastado vuelve a valer estos segundos.
 *
 * ## El día que esto se escribió — 22/09/2026
 *
 * La APK de reparto echó a Jose a la pantalla de entrar dos veces en veinte
 * minutos, en mitad de una descarga, sin que nadie robara nada. En el registro,
 * las dos veces: `todas las sesiones revocadas — motivo: refresh reutilizado`.
 *
 * Lo que pasa de verdad en una conexión con pérdidas —la de allá, y la del
 * teléfono con la línea saturada bajando 100 MB de mapa— es esto:
 *
 *  1. el aparato manda `POST /refresh` con R1;
 *  2. aquí se gasta R1 y se emite R2;
 *  3. **la respuesta se pierde por el camino.** El aparato sigue guardando R1,
 *     porque sólo guarda lo que recibe;
 *  4. el aparato lo intenta otra vez con R1 — y hasta hoy eso era «robo».
 *
 * Nadie se equivocó y aun así la cuenta entera se quedaba fuera. Y fuera de
 * verdad: para volver a entrar hace falta señal, así que a un repartidor en el
 * patio de un almacén esto le deja el día dentro del teléfono sin poder subirlo.
 *
 * **Lo que la gracia NO afloja.** Un ladrón que copia un refresh lo usa cuando
 * puede, no en los dos minutos siguientes a que el dueño lo gastara; y si lo
 * usa después de la ventana, la regla 3 salta igual que siempre. Lo único que
 * se le concede es lo que un reintento de red no puede distinguir de sí mismo.
 *
 * Dos minutos porque el reintento no es inmediato: el aparato vuelve a pedir
 * cuando algo lo necesita, y con la línea saturada eso llega tarde.
 *
 * ## Y lo que SÍ afloja, que costó una segunda vuelta el mismo día
 *
 * La primera versión de esto no tenía tope: la misma fila gastada se podía
 * canjear **una vez por intento** mientras durase la ventana. Cinco llamadas,
 * cinco pares válidos distintos, cinco ramas de 30 días. Un refresh robado no
 * sacaba un par: bifurcaba la familia, y como la reutilización se detecta cuando
 * una fila vuelve, tener ramas paralelas equivale a **apagar la detección de esa
 * cuenta durante un mes**. Cerraba de menos donde antes cerraba de más.
 *
 * El tope es `graceUsedAt`: **una gracia por fila**, reclamada de forma atómica
 * (`reclamarLaGracia`). Lo que queda en pie es exactamente lo que se midió el
 * 22/09/2026 —una respuesta perdida no cierra la cuenta—, y lo que se cierra es
 * que multiplicarse salga gratis.
 *
 * ## Por qué la gracia NO se ata al aparato, aunque parezca que debería
 *
 * Lo evidente sería exigir que el reintento traiga el mismo `clientId`, el mismo
 * `userAgent` o la misma IP. No se hace, y conviene que quede escrito por qué:
 *
 *  - **`clientId` y `userAgent` los escribe el cliente.** `clientId` es la
 *    constante `delivery-apk` y el `userAgent` es una cabecera de texto. Quien ha
 *    copiado el refresh ha copiado la petición entera: repetir dos cadenas no le
 *    cuesta nada. Atar a eso no es una comprobación, es un adorno que se lee como
 *    una defensa — y lo peligroso de una falsa defensa es que invita a ensanchar
 *    la ventana «porque ya está atada».
 *  - **La IP sí es difícil de falsificar, y justo por eso rompe el caso.** El
 *    reintento que esto existe para tolerar llega de un teléfono que cambió de
 *    celda, de un NAT de carrier que rota, o del salto de la línea de allá a
 *    Starlink. Atar a la IP convertiría la mitad de los reintentos legítimos en
 *    «robo» y devolvería, literalmente, el fallo del 22/09.
 *
 * Lo que sí se hace es **anotarlo**: la auditoría de la gracia deja dicho si el
 * cliente coincide (`mismoCliente`) junto con la IP y el `userAgent` de quien
 * pidió. Eso no bloquea a nadie, pero deja el rastro para responder «¿esto fue
 * una red mala o alguien con una copia?» sin tener que adivinarlo.
 */
export const SEGUNDOS_DE_GRACIA = 120;

/** La variable de entorno con el secreto de firma. La pone Dokploy. */
const SECRETO_ACCESO = 'JWT_SECRET';
/** Etiqueta del token, para que un token de otra cosa no cuele como acceso. */
export const PROPOSITO_ACCESO = 'apk:access';

/** Etiqueta del token de ENTREGA (ver `emitirEntrega`): distinta de la del acceso, para que ninguno cuele por el otro. */
export const PROPOSITO_ENTREGA = 'apk:entrega';
/** El único ámbito de ese token: dejar el trabajo sin enviar en la bandeja de revisión de Reparto. */
export const AMBITO_ENTREGA = 'reparto.entrega';
/** 10 minutos: lo que tarda en subirse una cola entera con mala red. Más largo no hace falta. */
export const SEGUNDOS_ENTREGA = 10 * 60;

/** Quién pide el par, para la auditoría. */
export const CLIENTE_POR_DEFECTO = 'delivery-apk';

export interface Par {
    token: string;
    refresh_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_expires_in: number;
}

export interface Identidad {
    sub: string;
    email: string;
    name: string;
    username: string | null;
    /** El rol principal, que es el que ya miran las comprobaciones existentes. */
    role: string | null;
    roles: string[];
    /** El CÓDIGO de la sucursal: CAM, HAB, STG… Vacío = ninguna (Super Admin). */
    sucursal: string;
    /** Todas las suyas, por si algún día hay que ofrecer un cambio sin volver a entrar. */
    sucursales: string[];
    /**
     * Las llaves `<app>.entrar` que tiene (ver `entradasDe`). SIEMPRE presente: `[]` es «no
     * entra a nada», y Reparto lo trata distinto de «ausente». Se re-firma en cada
     * renovación, así que un cambio de rol se nota en ≤ 15 minutos.
     */
    entradas: string[];
}

export type MotivoDeFallo =
    /** El token no existe: inventado, o de una base que ya no está. */
    | 'invalid'
    /** Ya se había canjeado. Es la regla 3: se revoca la cuenta entera. */
    | 'reuse'
    /**
     * Ya se había canjeado, vuelve DENTRO de la ventana, pero su única gracia ya
     * se gastó (regla 4). No se emite par y NO se cierra la cuenta: quien vuelve
     * una tercera vez con el mismo refresh es casi siempre un aparato que perdió
     * dos respuestas seguidas —el ladrón, que sí recibió su par en la primera,
     * no tiene ningún motivo para insistir con el viejo—, así que castigar esto
     * con la revocación en cadena sería castigar la mala red otra vez. Se queda
     * fuera ese aparato, que es lo que se puede afirmar; de cara al cliente es un
     * 401 igual que los demás.
     */
    | 'gracia_gastada'
    | 'expired'
    /** Lo cerramos nosotros: logout, revocación desde el panel, o baja de la persona. */
    | 'revoked'
    /** Entró bien pero no se le puede firmar un alcance. Ver `resolverIdentidad`. */
    | 'sin_sucursal'
    /**
     * Ya no tiene la llave de entrada (`delivery.entrar`): se le quitó después de
     * entrar. Sólo sale de `renovar`; ver `sinLlaveDeEntrada`. Si la base no contesta al
     * comprobarla NO sale esto: `renovar` lanza `ComprobacionNoDisponible` (un 503).
     */
    | 'sin_permiso';

export type Renovacion = { ok: true; par: Par } | { ok: false; motivo: MotivoDeFallo };

export class ErrorDeIdentidad extends Error {
    constructor(readonly motivo: MotivoDeFallo) {
        super(motivo);
        this.name = 'ErrorDeIdentidad';
    }
}

function hashDe(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
}

/**
 * Lo que va DENTRO del token: quién es, qué roles tiene y en qué sucursal.
 *
 * El rol es el de la PERSONA, como en `/api/auth/verify-session` (salvo la cuenta `isSystemAdmin`: ver `roles-de-la-persona.ts`): el de la
 * columna `role` de better-auth guarda su propio vocabulario ("owner", "member")
 * y quien buscara ahí "SUPERVISOR" no lo encontraba nunca.
 *
 * La sucursal es la parte delicada, porque la API del reparto trata **la
 * ausencia de sucursal como «las ocho»**: `resolveScope` acota sólo si el token
 * trae una. O sea que un token sin sucursal no es un token limitado, es el más
 * amplio que existe. Por eso:
 *
 *  - **Super Admin** → vacía, que es lo correcto: es quien ve las ocho y elige
 *    por cabecera.
 *  - **una sola sucursal** → esa.
 *  - **varias** → la que pida quien entra, comprobada contra las suyas; si no
 *    pide ninguna, la más antigua. Nunca la ausencia, que le abriría las ocho.
 *  - **ninguna y no es Super Admin** → NO se firma. Es preferible un error que
 *    se entiende —y que se arregla dándole su sucursal— a un token que enseña
 *    los pedidos de toda Cuba a quien no debería ver ni una.
 */
export async function resolverIdentidad(userId: string, sucursalPedida?: string | null): Promise<Identidad> {
    const persona = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            name: true,
            email: true,
            username: true,
            activo: true,
            isSystemAdmin: true,
            defaultRole: { select: { name: true } },
            members: {
                orderBy: { createdAt: 'asc' },
                select: {
                    organization: { select: { codigo: true, activa: true } },
                    memberRoles: { select: { role: { select: { name: true } } } },
                },
            },
        },
    });
    if (!persona || !persona.activo) throw new ErrorDeIdentidad('revoked');

    const roles = [
        ...(persona.defaultRole?.name ? [persona.defaultRole.name] : []),
        ...persona.members.flatMap((m) => m.memberRoles.map((mr) => mr.role.name)),
    ];
    // Con `SUPER ADMIN` añadido si es administradora del sistema (ver `rolesFirmados`):
    // una cuenta así puede no traer ni rol por defecto ni membresía, y sin esto Reparto
    // la dejaba fuera por la APK mientras la web sí la dejaba entrar.
    const rolesUnicos = rolesFirmados(roles, persona.isSystemAdmin);

    const sucursales = persona.members
        .map((m) => m.organization)
        .filter((o) => o.activa && o.codigo)
        .map((o) => o.codigo as string);

    let sucursal = '';
    if (!persona.isSystemAdmin) {
        if (sucursales.length === 0) throw new ErrorDeIdentidad('sin_sucursal');
        const pedida = sucursalPedida?.trim();
        if (pedida) {
            if (!sucursales.includes(pedida)) throw new ErrorDeIdentidad('sin_sucursal');
            sucursal = pedida;
        } else {
            sucursal = sucursales[0];
        }
    }

    // Las llaves de entrada que se firman. `accesoDe` ya cuenta el rol por defecto y TODAS
    // las membresías; una cuenta `isSystemAdmin` las trae todas sin consultar nada.
    const entradas = entradasDe(await accesoDe(persona.id, persona.isSystemAdmin));

    return {
        sub: persona.id,
        email: persona.email,
        name: persona.name,
        username: persona.username,
        role: rolPrincipal(persona.defaultRole?.name, persona.isSystemAdmin) ?? rolesUnicos[0] ?? null,
        roles: rolesUnicos,
        sucursal,
        sucursales,
        entradas,
    };
}

/**
 * El token de acceso.
 *
 * Los nombres de los campos no son una elección: son los que lee la API del
 * reparto. La sucursal va como `sucursal` y `branch_id` —los dos nombres del
 * token nuevo—, y **no** como `branchId`, que en la web significa otra cosa (el
 * id de la sucursal en la base de delivery, no su código).
 */
export async function firmarAcceso(identidad: Identidad, sessionId: string | null, leidoEn: number = Date.now()): Promise<string> {
    return signJwt(
        {
            sub: identidad.sub,
            email: identidad.email,
            name: identidad.name,
            role: identidad.role ?? '',
            roles: identidad.roles,
            sucursal: identidad.sucursal,
            branch_id: identidad.sucursal,
            sucursales: identidad.sucursales,
            // Siempre, aunque sea `[]`: ver `Identidad.entradas`. Siete cadenas como mucho.
            entradas: identidad.entradas,
            ...(sessionId ? { sid: sessionId } : {}),
            // La hora de emisión en MILISEGUNDOS. `iat` va en segundos y las marcas de invalidación
            // (`eventos-de-sesion.ts`) en ms: un token pedido 250 ms después del evento tenía `iat*1000`
            // por debajo de la marca en ~el 75 % de los casos y se rechazaba (la APK renueva justo al
            // recibir el aviso). El consumidor prefiere `iatms` y, si falta, usa `iat*1000`.
            // Es el instante en que se LEYERON los datos (`leidoEn`), no el de firmar: con la base lenta, un
            // cambio ocurrido entre la lectura y la firma no puede quedar por debajo de la marca de un token
            // que ya no lo refleja.
            iatms: leidoEn,
            // Sin esto, dos accesos firmados dentro del mismo segundo con los
            // mismos datos salen IDÉNTICOS byte a byte: mismo `iat`, mismo `exp`
            // y HS256 es determinista. No es inseguro —el token sigue siendo
            // suyo y caduca igual—, pero hace imposible seguir uno concreto por
            // los registros y borra la diferencia entre "me dieron uno nuevo" y
            // "me devolvieron el mismo".
            jti: randomUUID(),
        },
        {
            secretEnvVar: SECRETO_ACCESO,
            expiresIn: `${SEGUNDOS_ACCESO}s`,
            purpose: PROPOSITO_ACCESO,
        }
    );
}

export interface DatosDelAparato {
    clientId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
}

/**
 * Emite un par nuevo. Lo usan las dos puertas: el acceso con contraseña y la
 * renovación, que es exactamente la misma emisión con otra procedencia.
 */
export async function emitirPar(args: {
    userId: string;
    sessionId: string | null;
    /** La cadena de renovaciones. Se hereda al renovar; en un acceso nace una. */
    familyId?: string;
    sucursalPedida?: string | null;
    /** El refresh que se acaba de gastar, para poder seguir la cadena. */
    reemplazaA?: string | null;
    aparato?: DatosDelAparato;
}): Promise<Par> {
    const leidoEn = Date.now();
    const identidad = await resolverIdentidad(args.userId, args.sucursalPedida);
    const token = await firmarAcceso(identidad, args.sessionId, leidoEn);

    const raw = randomBytes(32).toString('base64url');
    const nueva = await prisma.refreshToken.create({
        data: {
            tokenHash: hashDe(raw),
            userId: args.userId,
            sessionId: args.sessionId,
            familyId: args.familyId ?? randomUUID(),
            clientId: args.aparato?.clientId ?? CLIENTE_POR_DEFECTO,
            expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000),
            ip: args.aparato?.ip ?? null,
            userAgent: args.aparato?.userAgent ?? null,
        },
        select: { id: true },
    });

    if (args.reemplazaA) {
        await prisma.refreshToken.update({
            where: { id: args.reemplazaA },
            data: { replacedBy: nueva.id },
        });
    }

    return {
        token,
        refresh_token: raw,
        token_type: 'Bearer',
        expires_in: SEGUNDOS_ACCESO,
        refresh_expires_in: SEGUNDOS_REFRESH,
    };
}

/**
 * La regla que hace que robar un token no sirva de nada: se cierra la cuenta
 * ENTERA, no el aparato.
 *
 * No se puede saber cuál de los dos que presentaron el mismo refresh es el
 * ladrón, así que cerrar "el otro" no es una opción. Quien de verdad trabaja
 * vuelve a entrar con su contraseña —que el ladrón no tiene— y el ladrón se
 * queda fuera.
 *
 * Se cierran las dos cosas: los refresh y las sesiones de better-auth, porque
 * quien entró por la APK tiene además una sesión abierta y dejarla viva sería
 * dejar la puerta de al lado sin cerrar.
 */
export async function revocarTodasLasSesiones(userId: string, motivo: string): Promise<void> {
    const ahora = new Date();
    await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: ahora },
    });
    await prisma.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: ahora, expiresAt: ahora }, // expiresAt: ver `revoke-session/route.ts`
    });
    logger.warn('[apk-tokens] todas las sesiones revocadas', { userId, motivo });
    // Un refresh robado: las aplicaciones tampoco pueden fiarse de lo que emitieron antes.
    await publicarSesionCerrada([userId], 'revocada');
}

/**
 * Renovar: comprobar el refresh, gastarlo y devolver un par nuevo.
 *
 * El orden importa. Se lee la fila para saber en qué estado estaba ANTES de
 * tocarla —así se distingue "ya se canjeó" (robo) de "lo cerramos nosotros"
 * (logout), que no es lo mismo y no merece el mismo castigo—, y sólo después se
 * gasta con un `updateMany` condicionado.
 *
 * Ese `updateMany` es el candado de verdad. Dos renovaciones a la vez con el
 * mismo token llegan las dos a la comprobación con la fila todavía limpia; lo
 * que no pueden es gastarla las dos, porque la segunda actualiza cero filas. Un
 * `findUnique` seguido de un `update` sin condición dejaría pasar las dos y
 * emitiría dos pares válidos del mismo refresh, que es justo lo que esto
 * persigue.
 */
export async function renovar(raw: string, aparato?: DatosDelAparato): Promise<Renovacion> {
    try {
        return await renovarSinAmparo(raw, aparato);
    } catch (e) {
        // Cualquier fallo inesperado (la base, casi siempre) es un 503, no un 500. Importa sobre todo cuando el
        // refresh YA se gastó (`updateMany` de abajo): el 500 no le dice a la app nada; el 503 sí, y su reintento
        // cae en la ventana de gracia y recibe su par. `ComprobacionNoDisponible` ya es 503: se deja pasar.
        if (e instanceof ComprobacionNoDisponible) throw e;
        throw new RenovacionNoDisponible(e);
    }
}

/** La base (u otra pieza nuestra) falló a mitad de renovar. `/refresh` lo contesta con 503. */
export class RenovacionNoDisponible extends ComprobacionNoDisponible {
    constructor(cause: unknown) {
        super(cause);
        this.name = 'RenovacionNoDisponible';
        this.message = `falló la renovación: ${(cause as Error)?.message ?? cause}`;
    }
}

async function renovarSinAmparo(raw: string, aparato?: DatosDelAparato): Promise<Renovacion> {
    const fila = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashDe(raw) },
        select: {
            id: true,
            userId: true,
            sessionId: true,
            familyId: true,
            clientId: true,
            expiresAt: true,
            usedAt: true,
            revokedAt: true,
        },
    });
    // Un token que no está en la tabla no dice de quién es, así que no hay nada
    // que revocar ni a quién avisar. No es un robo detectable: es ruido.
    if (!fila) return { ok: false, motivo: 'invalid' };

    const ahora = new Date();

    if (fila.usedAt) {
        // GASTADO. Tres salidas, y el orden es la mitad del arreglo:
        //
        //  1. **Revocado por nosotros → `revoked`.** Un `revokedAt` lo ponemos
        //     nosotros: un logout, el panel de Personas, o una revocación previa.
        //     Hasta hoy esto caía en la rama de robo y cerraba la cuenta ENTERA,
        //     o sea que un logout que se cruzaba con la renovación en vuelo hacía
        //     exactamente el daño que la gracia venía a quitar. Cerrar lo ya
        //     cerrado no protege de nada: la familia está muerta y el token no
        //     abre ninguna puerta.
        //  2. **Fuera de la ventana → la regla 3, intacta.** Cuenta entera.
        //  3. **Dentro de la ventana → la gracia, UNA vez** (regla 4).
        if (fila.revokedAt) return { ok: false, motivo: 'revoked' };
        if (!dentroDeLaGracia(fila.usedAt, ahora)) return esUnRobo(fila, aparato, false);
        return conLaGracia(fila, ahora, aparato, 'la respuesta anterior no llegó');
    }
    if (fila.revokedAt) return { ok: false, motivo: 'revoked' };

    // La puerta, ANTES de gastar el refresh: sin la llave no se renueva y no se toca
    // nada, así que si se la devuelven mañana el mismo refresh vuelve a valer.
    const cerrada = await puertaDeRenovar(fila, ahora, aparato);
    if (cerrada) return { ok: false, motivo: cerrada };

    const gastado = await prisma.refreshToken.updateMany({
        where: { id: fila.id, usedAt: null, revokedAt: null },
        data: { usedAt: ahora },
    });
    if (gastado.count === 0) {
        // Otra petición se lo llevó entre la lectura y aquí. Dos peticiones a la
        // vez con el mismo token es el aparato mandándolo dos veces, no un
        // ladrón: se vuelve a leer la fila para saber qué le pasó y se trata
        // igual que arriba, con las mismas tres salidas y en el mismo orden.
        const otraVez = await prisma.refreshToken.findUnique({
            where: { id: fila.id },
            select: { usedAt: true, revokedAt: true },
        });
        if (otraVez?.revokedAt) return { ok: false, motivo: 'revoked' };
        // Sin `usedAt` y sin `revokedAt` la fila se movió por debajo de una forma
        // que no sabemos explicar: eso no entra en la gracia.
        if (!otraVez?.usedAt || !dentroDeLaGracia(otraVez.usedAt, ahora)) {
            return esUnRobo(fila, aparato, true);
        }
        return conLaGracia(fila, ahora, aparato, 'dos peticiones a la vez');
    }

    return emitirDesde(fila, ahora, aparato, null);
}

/** La regla 3 entera: se cierra la cuenta y queda dicho en la auditoría. */
async function esUnRobo(
    fila: { id: string; userId: string; familyId: string },
    aparato: DatosDelAparato | undefined,
    carrera: boolean
): Promise<Renovacion> {
    await revocarTodasLasSesiones(
        fila.userId,
        carrera ? 'refresh reutilizado (a la vez)' : 'refresh reutilizado'
    );
    audit({
        action: 'auth.refresh.reuse',
        userId: fila.userId,
        clientId: aparato?.clientId ?? CLIENTE_POR_DEFECTO,
        ip: aparato?.ip ?? null,
        userAgent: aparato?.userAgent ?? null,
        meta: { refreshTokenId: fila.id, familyId: fila.familyId, ...(carrera ? { carrera: true } : {}) },
    });
    return { ok: false, motivo: 'reuse' };
}

/**
 * La gracia, con su tope: se reclama `graceUsedAt` y sólo el que se lo lleva
 * emite.
 *
 * El `updateMany` condicionado a `graceUsedAt: null` es el mismo candado que ya
 * sujeta `usedAt`, y es lo único que aguanta el ataque de verdad: cinco
 * peticiones a la vez con el refresh robado. Contar las ramas vivas de la familia
 * —dos vivas sin gastar = la gracia ya se usó— habría evitado la migración, pero
 * no es atómico: las cinco cuentan una y las cinco se conceden. Aquí la base dice
 * que sí una vez.
 *
 * Quien llega segundo NO recibe par y NO cierra la cuenta: ver `gracia_gastada`.
 */
async function conLaGracia(
    fila: FilaDeRefresh,
    ahora: Date,
    aparato: DatosDelAparato | undefined,
    motivo: string
): Promise<Renovacion> {
    // Igual que en el camino normal: sin la llave no se emite, y no se gasta la gracia.
    const cerrada = await puertaDeRenovar(fila, ahora, aparato);
    if (cerrada) return { ok: false, motivo: cerrada };

    const concedida = await prisma.refreshToken.updateMany({
        where: { id: fila.id, graceUsedAt: null },
        data: { graceUsedAt: ahora },
    });
    if (concedida.count === 0) {
        logger.warn('[apk-tokens] la gracia de esta fila ya estaba gastada', {
            userId: fila.userId,
            familyId: fila.familyId,
            motivo,
        });
        audit({
            action: 'auth.refresh.gracia_agotada',
            userId: fila.userId,
            clientId: aparato?.clientId ?? CLIENTE_POR_DEFECTO,
            ip: aparato?.ip ?? null,
            userAgent: aparato?.userAgent ?? null,
            meta: { refreshTokenId: fila.id, familyId: fila.familyId, motivo },
        });
        return { ok: false, motivo: 'gracia_gastada' };
    }
    return emitirDesde(fila, ahora, aparato, motivo);
}

/**
 * La puerta de `renovar`, EN ESTE ORDEN: primero que la sesión y la persona sigan vivas, y sólo
 * después la llave. Devuelve el motivo de fallo, o `null` si se puede seguir.
 *
 * El orden es el arreglo (A.4.1 de `delivery-logistica/docs/bandeja-de-revision.md`). Con la llave
 * primero, quien perdió `delivery.entrar` Y además tenía la sesión revocada (o la baja) recibía un
 * 403 `sin_permiso` «de buena fe» en lugar de un 401: la app lo toma por «sesión viva, sin permiso»
 * y se pone a entregar su cola a revisión, cuando no le queda sesión con la que entregarla. Así, el 403
 * de `/refresh` quiere decir de verdad «tienes sesión, no tienes llave».
 */
async function puertaDeRenovar(
    fila: FilaDeRefresh,
    ahora: Date,
    aparato: DatosDelAparato | undefined
): Promise<MotivoDeFallo | null> {
    if (await sesionOPersonaMuerta(fila, ahora)) return 'revoked';
    if (await sinLlaveDeEntrada(fila, ahora, aparato)) return 'sin_permiso';
    return null;
}

/**
 * ¿Está revocada (o ya no existe) la sesión de este refresh, o dada de baja la persona? Si sí, se cierra
 * la familia —como hace `emitirDesde`— y el refresh NO se gasta. Un refresh caducado no se mira: lo dice
 * `emitirDesde` (`expired`), como siempre.
 */
async function sesionOPersonaMuerta(fila: FilaDeRefresh, ahora: Date): Promise<boolean> {
    if (fila.expiresAt.getTime() <= ahora.getTime()) return false;
    const sesion = fila.sessionId
        ? await prisma.session.findUnique({ where: { id: fila.sessionId }, select: { revokedAt: true } })
        : { revokedAt: null };
    if (sesion && !sesion.revokedAt) {
        const persona = await prisma.user.findUnique({ where: { id: fila.userId }, select: { activo: true } });
        if (persona?.activo) return false;
    }
    await cerrarFamilia(fila.familyId);
    return true;
}

/**
 * ¿Ha perdido la persona la llave de entrada de la aplicación con la que nació este
 * refresh? Misma comprobación que la puerta del login (`delivery-apk` → `delivery.entrar`).
 *
 * Renovar es seguir entrando: sin esto, quien hoy no tiene permiso seguiría renovando
 * 30 días con el refresh de cuando sí lo tenía.
 *
 * Si la base no contesta, `comprobarEntrada` LANZA (`ComprobacionNoDisponible`) y se deja
 * subir: `/refresh` lo contesta con un 503 y el refresh no se gasta. Un «sin permiso»
 * falso aquí dejaría a la APK en la pantalla de «perdiste el permiso» hasta recargar.
 *
 * Se decide con `fila.clientId` (con quién nació el refresh); `null` = una fila anterior a
 * la columna, que es `CLIENTE_POR_DEFECTO`. Un refresh ya caducado NO se mira: sale como
 * `expired`, que es lo que es.
 */
async function sinLlaveDeEntrada(
    fila: { id: string; userId: string; clientId: string | null; expiresAt: Date },
    ahora: Date,
    aparato: DatosDelAparato | undefined
): Promise<boolean> {
    if (fila.expiresAt.getTime() <= ahora.getTime()) return false;
    const clientId = fila.clientId ?? CLIENTE_POR_DEFECTO;
    if (await comprobarEntrada(fila.userId, clientId)) return false;
    audit({
        action: 'auth.apk.denied',
        userId: fila.userId,
        clientId,
        ip: aparato?.ip ?? null,
        userAgent: aparato?.userAgent ?? null,
        meta: { via: 'refresh', refreshTokenId: fila.id },
    });
    return true;
}

/** ¿Se gastó hace tan poco que no se puede distinguir de un reintento de red? */
function dentroDeLaGracia(usado: Date, ahora: Date): boolean {
    const pasado = ahora.getTime() - usado.getTime();
    // El `>= 0` no sobra: un reloj que va hacia atrás daría un negativo, y un
    // negativo «dentro de la ventana» convertiría la gracia en barra libre.
    return pasado >= 0 && pasado <= SEGUNDOS_DE_GRACIA * 1000;
}

/** La fila que hace falta para emitir. Se escribe suelta para poder pasarla. */
type FilaDeRefresh = {
    id: string;
    userId: string;
    sessionId: string | null;
    familyId: string;
    /** Con quién nació la fila. De él depende la llave que se pide al renovar (`sinLlaveDeEntrada`). */
    clientId: string | null;
    expiresAt: Date;
};

/**
 * Emitir el par a partir de la fila ya comprobada. Es el final común de los tres
 * caminos: la renovación normal y las dos de gracia.
 *
 * En los de gracia **se emite un par nuevo, no se repite el anterior**: el
 * anterior sólo existe aquí como `sha256`, así que devolverlo es imposible. El
 * que se perdió se queda en la tabla sin gastar y caduca solo — nadie lo tiene,
 * porque nunca llegó a ningún sitio.
 */
async function emitirDesde(
    fila: FilaDeRefresh,
    ahora: Date,
    aparato: DatosDelAparato | undefined,
    gracia: string | null
): Promise<Renovacion> {
    if (fila.expiresAt.getTime() <= ahora.getTime()) {
        await prisma.refreshToken.update({ where: { id: fila.id }, data: { revokedAt: ahora } });
        return { ok: false, motivo: 'expired' };
    }

    // La sesión de better-auth (y la baja) ya se miraron en `puertaDeRenovar`, ANTES de la llave y de
    // gastar el refresh: una sola lectura, no dos. Si la revocan entre aquella lectura y el estirón de
    // `expiresAt` de más abajo, NO se resucita: ese `updateMany` va condicionado a `revokedAt: null`
    // (`revocacion-efectiva.test.ts`, «renovar no resucita una sesión revocada»).

    try {
        const par = await emitirPar({
            userId: fila.userId,
            sessionId: fila.sessionId,
            familyId: fila.familyId,
            reemplazaA: fila.id,
            aparato,
        });
        // La sesión se estira con cada renovación. Sin esto, la caducidad natural
        // de better-auth (7 días) mataría a un aparato que lleva tres semanas
        // renovando sin fallo, y el refresh de 30 días no habría servido de nada.
        if (fila.sessionId) {
            await prisma.session.updateMany({
                // `revokedAt: null`: si la revocaron justo ahora, estirarla la resucitaría (su `expiresAt` es lo que la mata).
                where: { id: fila.sessionId, revokedAt: null },
                data: { expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000) },
            });
        }
        if (gracia) {
            // Se deja dicho, porque es lo que hay que poder contar después: la
            // cuenta NO se cerró, y por qué.
            logger.warn('[apk-tokens] refresh repetido dentro de la ventana de gracia', {
                userId: fila.userId,
                familyId: fila.familyId,
                motivo: gracia,
            });
            audit({
                action: 'auth.refresh.gracia',
                userId: fila.userId,
                clientId: aparato?.clientId ?? CLIENTE_POR_DEFECTO,
                ip: aparato?.ip ?? null,
                userAgent: aparato?.userAgent ?? null,
                meta: {
                    refreshTokenId: fila.id,
                    familyId: fila.familyId,
                    motivo: gracia,
                    // Se ANOTA, no se exige. Un ladrón que copia el refresh copia
                    // también la cabecera, así que esto no sirve de guarda; sirve
                    // para poder mirar después si la gracia la están usando redes
                    // malas o alguien con una copia. El porqué entero, arriba en
                    // `SEGUNDOS_DE_GRACIA`.
                    mismoCliente:
                        (aparato?.clientId ?? CLIENTE_POR_DEFECTO) ===
                        (fila.clientId ?? CLIENTE_POR_DEFECTO),
                },
            });
        }
        return { ok: true, par };
    } catch (e) {
        if (e instanceof ErrorDeIdentidad) {
            await cerrarFamilia(fila.familyId);
            return { ok: false, motivo: e.motivo };
        }
        throw e;
    }
}

/**
 * Por qué NO se firmó un token de entrega. El cliente sólo ve el código HTTP (401/403/409); el motivo
 * va a la auditoría (`auth.apk.entrega_denegada`) y sirve para las pruebas.
 */
export type MotivoDeEntrega =
    // 401: no hay sesión viva con la que entregar. Todos salen con el mismo cuerpo que `/refresh`.
    | 'refresh_inexistente'
    | 'refresh_revocado'
    | 'refresh_gastado'
    | 'refresh_caducado'
    | 'otro_cliente'
    | 'sesion_revocada'
    | 'baja'
    // 403: persona sin alcance (sin sucursal): no se le firma nada.
    | 'sin_sucursal'
    // 409: SÍ tiene `delivery.entrar`; que renueve con `/refresh`.
    | 'tiene_permiso';

export type Entrega =
    | { ok: true; token: string; expires_in: number; ambito: string }
    | { ok: false; motivo: MotivoDeEntrega };

/**
 * El token de ENTREGA: lo que se le da a quien conserva sesión viva pero ya NO tiene `delivery.entrar`
 * para que pueda dejar su trabajo sin enviar en la bandeja de revisión (diseño B.1 de
 * `delivery-logistica/docs/bandeja-de-revision.md`). Sirve para UNA cosa, dura 10 minutos y no abre
 * nada de Reparto: ni roles (`roles: []`, `role: ''`), ni llaves (`entradas: []`, que para la API y
 * `sync` es «no entra a nada»), y lleva `purpose` y `ambito` fijos.
 *
 * **No gasta el refresh y no devuelve refresh**: el de 30 días no sale del aparato más que por
 * `/refresh`. Por eso ni escribe en la base: sólo lee, firma y deja su rastro en la auditoría.
 *
 * ## Las comprobaciones, en ESTE orden, y la llave la ÚLTIMA
 *
 * Una persona sin llave y con la sesión revocada, o de baja, NO entrega: esto es lo que impide que la
 * bandeja sirva para saltarse un cierre de sesión. Por eso se mira primero que el refresh sea la cabeza
 * viva de su cadena (existe, sin revocar, sin gastar, sin caducar), luego la SESIÓN, luego la persona
 * (`resolverIdentidad`: baja → `revoked`; sin sucursal → `sin_sucursal`), y sólo al final la llave.
 * Un refresh ya gastado es un 401 SIN revocar la cuenta: castigar los robos es cosa de `/refresh`.
 *
 * Quien SÍ tiene la llave no recibe nada (409): si no, podría usar la revisión para que otro aplique
 * sus gestos con más autoridad de la que tiene el aparato. La llave se lee de las `entradas` que ya
 * calculó `resolverIdentidad`, que son las mismas que firma el acceso normal.
 *
 * Si la base falla lanza (sin tragar nada): la ruta lo contesta con un 503 y la app conserva todo.
 */
export async function emitirEntrega(raw: string, aparato?: DatosDelAparato): Promise<Entrega> {
    const ahora = new Date();
    const fila = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashDe(raw) },
        select: { id: true, userId: true, sessionId: true, clientId: true, expiresAt: true, usedAt: true, revokedAt: true },
    });
    // Un token que no está en la tabla no dice de quién es: ruido, sin rastro (como en `renovar`).
    if (!fila) return { ok: false, motivo: 'refresh_inexistente' };

    const denegar = (motivo: MotivoDeEntrega): Entrega => {
        audit({
            action: 'auth.apk.entrega_denegada',
            userId: fila.userId,
            clientId: CLIENTE_POR_DEFECTO,
            ip: aparato?.ip ?? null,
            userAgent: aparato?.userAgent ?? null,
            meta: { motivo, refreshTokenId: fila.id, sessionId: fila.sessionId },
        });
        return { ok: false, motivo };
    };

    if (fila.revokedAt) return denegar('refresh_revocado');
    if (fila.usedAt) return denegar('refresh_gastado');
    if (fila.expiresAt.getTime() <= ahora.getTime()) return denegar('refresh_caducado');
    // El token es de Reparto: un refresh de otra aplicación no lo produce.
    if ((fila.clientId ?? CLIENTE_POR_DEFECTO) !== CLIENTE_POR_DEFECTO) return denegar('otro_cliente');

    const sesion = fila.sessionId
        ? await prisma.session.findUnique({
              where: { id: fila.sessionId },
              select: { revokedAt: true, expiresAt: true },
          })
        : null;
    if (!fila.sessionId || !sesion || sesion.revokedAt || sesion.expiresAt.getTime() <= ahora.getTime()) {
        return denegar('sesion_revocada');
    }

    let identidad: Identidad;
    try {
        identidad = await resolverIdentidad(fila.userId);
    } catch (e) {
        if (e instanceof ErrorDeIdentidad) return denegar(e.motivo === 'sin_sucursal' ? 'sin_sucursal' : 'baja');
        throw e;
    }

    if (identidad.entradas.includes(LLAVE_DEL_CLIENTE[CLIENTE_POR_DEFECTO])) return denegar('tiene_permiso');

    const token = await signJwt(
        {
            sub: identidad.sub,
            // El nombre, para que la bandeja diga «Yasmani» y no un uuid; sale de aquí, no del cuerpo de la entrega.
            name: identidad.name,
            email: identidad.email,
            sid: fila.sessionId,
            sucursal: identidad.sucursal,
            branch_id: identidad.sucursal,
            ambito: AMBITO_ENTREGA,
            // Sin roles ni llaves a propósito: nada que un verificador pueda tomar por un permiso.
            entradas: [] as string[],
            roles: [] as string[],
            role: '',
            // Igual que el acceso (ver `firmarAcceso`): la hora en ms, para las marcas de invalidación, y la
            // de LEER la sesión (`ahora`, antes de la primera consulta), no la de firmar.
            iatms: ahora.getTime(),
            jti: randomUUID(),
        },
        { secretEnvVar: SECRETO_ACCESO, expiresIn: `${SEGUNDOS_ENTREGA}s`, purpose: PROPOSITO_ENTREGA }
    );
    audit({
        action: 'auth.apk.entrega',
        userId: fila.userId,
        clientId: CLIENTE_POR_DEFECTO,
        ip: aparato?.ip ?? null,
        userAgent: aparato?.userAgent ?? null,
        meta: { refreshTokenId: fila.id, sessionId: fila.sessionId },
    });
    return { ok: true, token, expires_in: SEGUNDOS_ENTREGA, ambito: AMBITO_ENTREGA };
}

/** Cierra UN aparato: la cadena entera de renovaciones y su sesión. */
export async function cerrarFamilia(familyId: string): Promise<void> {
    const ahora = new Date();
    const dela = await prisma.refreshToken.findFirst({
        where: { familyId },
        select: { sessionId: true },
    });
    await prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: ahora },
    });
    if (dela?.sessionId) {
        await prisma.session.updateMany({
            where: { id: dela.sessionId, revokedAt: null },
            data: { revokedAt: ahora, expiresAt: ahora },
        });
    }
}

/**
 * Cierra TODAS las cadenas de refresh de una persona, y las sesiones que llevan ligadas. Es lo que hace
 * falta al cambiarle o restablecerle la contraseña: `revokeSessions…` de better-auth sólo toca SUS sesiones,
 * y `renovar` no las mira, así que un refresh robado de la APK o del escritorio sobrevivía 30 días al
 * cambio. A partir de aquí `renovar` contesta `revoked` y quien trabaja vuelve a entrar con la clave nueva.
 * No publica nada: el aviso lo da quien llama. Devuelve cuántos refresh cerró.
 */
export async function cerrarTodasLasFamiliasDe(userId: string): Promise<number> {
    const ahora = new Date();
    const vivas = await prisma.refreshToken.findMany({
        where: { userId, revokedAt: null },
        select: { sessionId: true },
        distinct: ['sessionId'],
    });
    const { count } = await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: ahora },
    });
    const sesiones = vivas.flatMap((r) => (r.sessionId ? [r.sessionId] : []));
    if (sesiones.length > 0) {
        await prisma.session.updateMany({
            where: { userId, id: { in: sesiones }, revokedAt: null },
            data: { revokedAt: ahora, expiresAt: ahora },
        });
    }
    return count;
}

/**
 * Cerrar sesión desde el aparato.
 *
 * Cierra SÓLO ese aparato, no la cuenta: quien cierra sesión en el teléfono no
 * está diciendo que le hayan robado nada, y echar de paso al mismo de su sesión
 * web sería una sorpresa desagradable.
 *
 * Devuelve siempre lo mismo pase lo que pase con el token — existía, no existía,
 * ya estaba cerrado —: el cliente ya ha decidido salir y un error aquí sólo le
 * dejaría la sesión abierta por haber perdido la red.
 */
export async function cerrarSesionDelAparato(raw: string, aparato?: DatosDelAparato): Promise<void> {
    const fila = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashDe(raw) },
        select: { id: true, userId: true, familyId: true },
    });
    if (!fila) return;
    await cerrarFamilia(fila.familyId);
    // NO se publica ningún aviso (Jose, 08/10/2026: «la web es la web y las APK son la APK»): cerrar la
    // sesión de ESTE aparato es cosa de este aparato; no debe cerrar las webs de la persona ni sus otros
    // dispositivos. Los cortes que SÍ alcanzan al aparato son los de seguridad (`alcance: 'todo'`).
    audit({
        action: 'auth.apk.logout',
        userId: fila.userId,
        clientId: aparato?.clientId ?? CLIENTE_POR_DEFECTO,
        ip: aparato?.ip ?? null,
        userAgent: aparato?.userAgent ?? null,
        meta: { familyId: fila.familyId },
    });
}

/**
 * De dónde viene la petición, con el mismo orden de cabeceras que `lib/auth.ts`.
 *
 * Que los dos sitios lean lo mismo no es cosmético: si la sesión guarda una IP y
 * la auditoría del token otra, «¿desde dónde entró?» tiene dos respuestas y
 * ninguna sirve.
 */
export function desdeDondePide(cabeceras: Headers): DatosDelAparato {
    for (const nombre of ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for']) {
        // x-forwarded-for es una cadena separada por comas; el cliente es el primero.
        const valor = cabeceras.get(nombre)?.split(',')[0]?.trim();
        if (valor) {
            return { ip: valor, userAgent: cabeceras.get('user-agent') };
        }
    }
    return { ip: null, userAgent: cabeceras.get('user-agent') };
}

/** Sólo para las pruebas y para quien tenga que buscar una fila por su token. */
export const _hashDe = hashDe;
