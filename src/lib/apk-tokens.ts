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
import { rolesFirmados, rolPrincipal } from '@/lib/roles-de-la-persona';

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
    | 'sin_sucursal';

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

    return {
        sub: persona.id,
        email: persona.email,
        name: persona.name,
        username: persona.username,
        role: rolPrincipal(persona.defaultRole?.name, persona.isSystemAdmin) ?? rolesUnicos[0] ?? null,
        roles: rolesUnicos,
        sucursal,
        sucursales,
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
export async function firmarAcceso(identidad: Identidad, sessionId: string | null): Promise<string> {
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
            ...(sessionId ? { sid: sessionId } : {}),
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
    const identidad = await resolverIdentidad(args.userId, args.sucursalPedida);
    const token = await firmarAcceso(identidad, args.sessionId);

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
        data: { revokedAt: ahora },
    });
    logger.warn('[apk-tokens] todas las sesiones revocadas', { userId, motivo });
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
    /** Con quién nació la fila. NO se compara para decidir: sólo se anota. */
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

    // La sesión de better-auth es lo que permite cerrar un aparato desde el panel
    // de Personas. Si la revocaron ahí, la APK se cae aquí — como mucho 15 minutos
    // después, que es lo que le quede al acceso que ya tiene.
    if (fila.sessionId) {
        const sesion = await prisma.session.findUnique({
            where: { id: fila.sessionId },
            select: { revokedAt: true },
        });
        if (!sesion || sesion.revokedAt) {
            await cerrarFamilia(fila.familyId);
            return { ok: false, motivo: 'revoked' };
        }
    }

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
                where: { id: fila.sessionId },
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
            data: { revokedAt: ahora },
        });
    }
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
