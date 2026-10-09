import { accesoDe, type Acceso } from '@/lib/aplicaciones-visibles'
import { logger } from '@/lib/logger'

/**
 * LA PUERTA: Accesos no entrega el código de entrada a una aplicación cuya llave
 * `<app>.entrar` la persona no tiene.
 *
 * `aplicaciones-visibles.ts` decide qué tarjetas se ENSEÑAN; esto decide si se DEJA
 * ENTRAR. Sin esto bastaba con pegar la dirección de la aplicación: la tarjeta no
 * estaba, pero el login de la aplicación mandaba a la persona aquí y se le daba el
 * código igual. De las aplicaciones que pasan por Accesos para entrar, solo Rutas
 * comprobaba `rutas.entrar` por su cuenta; Delivery, AFT y Avisos no.
 *
 * ## Dónde se llama
 *
 *  - `/api/auth/callback`: el único sitio que acuña el código (`createAuthCode`).
 *  - `(user)/page.tsx`: la ruta vieja `?op=`, que acuña el suyo (`buildExternalRedirectUrl`).
 *  - `/api/auth/exchange`: otra vez al canjear el código (60 s de vida): la cookie de
 *    flujo no está firmada, y la llave pudo quitarse entre medias.
 *  - `/api/auth/token`: el login de la APK, con `comprobarEntrada`.
 *  - `/api/auth/refresh` (vía `renovar`, en `apk-tokens.ts`): renovar es seguir entrando,
 *    así que pide la misma llave, con `comprobarEntrada`. NO gasta el refresh si falla.
 *
 * `verify-session` NO se toca: lo llaman todas las aplicaciones en cada petición y un
 * rechazo ahí lo leen como «no hay sesión» y desconectan a la persona.
 *
 * ## Dos formas de preguntar lo mismo: qué pasa si la base no contesta
 *
 *  - `puedeEntrar` (la web: callback, `?op=`, exchange) FALLA CERRADO: no entra, y queda
 *    en el registro. Quien no entra vuelve a intentarlo.
 *  - `comprobarEntrada` (la APK: login y refresco) LANZA `ComprobacionNoDisponible`. La
 *    app de Reparto toma un 403 `sin_permiso` por «perdiste el permiso» y se queda en
 *    esa pantalla hasta recargar, mientras que un 5xx lo trata bien (conserva los
 *    tokens y reintenta). Una caída pasajera de la base no puede salir como «sin permiso».
 *
 * ## `entradas`
 *
 * Auth manda en lo que cada persona ve y puede hacer en cada aplicación, y Reparto es un
 * microservicio que decide por lo que Auth le firma. Por eso Accesos FIRMA las llaves de
 * entrada de la persona (`entradasDe`): en el JWT de acceso de la APK y en la respuesta
 * de `/api/auth/exchange`. Siempre presente; `[]` = «no entra a nada», que no es lo mismo
 * que ausente.
 */

/**
 * `clientId` de la tabla `client_app` → la llave que da entrada. OJO: son los ids de
 * `client_app`, que no son los de la vista (`rutas` allí, `procovar-rutas` aquí).
 *
 * Comprobado en el código de cada aplicación qué `clientId` manda al llamar a Accesos:
 * AFT `aft` (`aft-cmg/backend/src/procovar-auth.js`), Delivery y el reparto nuevo
 * `delivery` (`delivery/src/lib/procovar-auth.ts`, `delivery-logistica/api/internal/config`),
 * Rutas `procovar-rutas`, Avisos `procovar-notify`, PEDIDO `pedido`. `reparto` está en
 * `client_app` de producción y entra por Reparto, igual que `delivery`. `delivery-apk`
 * es el de `apk-tokens.ts` (`CLIENTE_POR_DEFECTO`).
 *
 * Lo que NO está aquí pasa como hasta ahora, sin inventar llaves: ver `SIN_LLAVE`. Un
 * `clientId` que no esté ni aquí ni allí FALLA ABIERTO (entra), así que una errata en un
 * id deja la puerta abierta sin avisar: la prueba de `puerta-de-entrada.test.ts` compara
 * los ids de `sync-clients.ts` y del seed con las dos listas, y `comprobarEntrada` deja
 * un `logger.info` cada vez que deja pasar uno sin mapa.
 */
export const LLAVE_DEL_CLIENTE: Readonly<Record<string, string>> = {
    pedido: 'pedido.entrar',
    analitics: 'analitics.entrar',
    aft: 'aft.entrar',
    ccsa: 'ccsa.entrar',
    delivery: 'delivery.entrar',
    reparto: 'delivery.entrar',
    'delivery-apk': 'delivery.entrar',
    'procovar-rutas': 'rutas.entrar',
    'procovar-notify': 'avisos.entrar',
}

/** Cómo se llama cada una de cara a la persona, para decirle a qué no entra. */
export const NOMBRE_DEL_CLIENTE: Readonly<Record<string, string>> = {
    pedido: 'PEDIDO',
    analitics: 'Analitics',
    aft: 'Activos fijos',
    ccsa: 'Tablero Parranda',
    delivery: 'Delivery',
    reparto: 'Reparto',
    'delivery-apk': 'Reparto',
    'procovar-rutas': 'Rutas',
    'procovar-notify': 'Avisos',
}

/**
 * Los `clientId` que están DECIDIDOS como «sin llave» (no figuran en el mapa a propósito).
 * Un cliente nuevo en `sync-clients.ts` o en el seed que no esté en el mapa NI aquí hace
 * fallar `puerta-de-entrada.test.ts`: hay que decidir si lleva llave antes de desplegarlo.
 */
export const SIN_LLAVE: readonly string[] = [
    // Ninguna persona entra por ellos: son servicios.
    'procovar-sync',
    // Tiene su propio login por contraseña y no hay `asignacion.entrar` en el catálogo.
    'asignacion',
    // El CRM de Amado aún no está registrado. Cuando entre habrá que aceptar un `client_id`
    // de lista cerrada con su llave (ver `docs/identidad-para-el-crm.md`), no dejarlo aquí.
    'crm',
    // Ids de TARJETA del seed (`rbac/procovar.ts`): `rutas` es la tarjeta de `procovar-rutas`
    // (su `client_app` de verdad), y de `entrega`, `caja`, `traslado` y `portal` el catálogo
    // no tiene llave de entrada (ver `LLAVE_DE_ENTRADA` en `aplicaciones-visibles.ts`). Un
    // código acuñado para `rutas` no lo canjea Rutas: va atado al `clientId` que lo emitió.
    'rutas',
    'entrega',
    'caja',
    'traslado',
    'portal',
]

/**
 * Las llaves de entrada que Accesos FIRMA (`entradas`): las del mapa, sin repetir (tres
 * clientes abren con `delivery.entrar`) y en el orden del mapa. Son siete.
 */
export const LLAVES_DE_ENTRADA: readonly string[] = [...new Set(Object.values(LLAVE_DEL_CLIENTE))]

/**
 * El valor de `entradas` para esta persona: sus llaves de entrada, o todas si es
 * administradora de sistema. SIEMPRE un array (`[]` = no entra a nada), sin duplicados y
 * en el orden estable del mapa. Lo calculan igual la APK (JWT) y `/api/auth/exchange`.
 */
export function entradasDe(acceso: Acceso): string[] {
    return LLAVES_DE_ENTRADA.filter((k) => acceso.todo || acceso.llaves.has(k))
}

/** La base no contestó al comprobar la llave: no se sabe si entra, y NO es «sin permiso». */
export class ComprobacionNoDisponible extends Error {
    constructor(cause: unknown) {
        super(`no se pudo comprobar la llave de entrada: ${(cause as Error)?.message ?? cause}`)
        this.name = 'ComprobacionNoDisponible'
        this.cause = cause
    }
}

/** El 403 de la APK. Un solo cuerpo para `/token` y `/refresh`: la app lee `codigo`. */
export const CUERPO_SIN_PERMISO = {
    error: 'sin_permiso',
    codigo: 'sin_permiso',
    message: 'No tienes permiso para entrar a Reparto.',
} as const

/** El 503 de la APK cuando no se pudo comprobar. La app conserva los tokens y reintenta. */
export const CUERPO_NO_DISPONIBLE = { error: 'comprobacion_no_disponible' } as const

/**
 * ¿Puede esta persona entrar a esta aplicación? Si la base falla, LANZA
 * `ComprobacionNoDisponible`: es la de la APK (login y refresco), donde eso debe ser un 503.
 *
 * Sí si es administrador de sistema, si tiene la llave, o si la aplicación no tiene
 * llave en el mapa (eso ni toca la base). Una cuenta de baja (`activo=false`) PASA por defecto
 * (`bajaPasa`, la APK): decidir eso no es de la puerta sino de `resolverIdentidad`, que la
 * cierra con `revoked`; sin esto una cuenta de baja sin la llave recibía 403 `sin_permiso`.
 * La WEB (`puedeEntrar`, y `/exchange`) pasa `bajaPasa: false`: ahí nadie cierra con `revoked`, y
 * una baja entraba a las ocho aplicaciones con su sesión de antes (revisión del 09/10/2026).
 */
export async function comprobarEntrada(
    userId: string,
    clientId: string | null | undefined,
    { bajaPasa = true }: { bajaPasa?: boolean } = {},
): Promise<boolean> {
    if (!clientId || !Object.hasOwn(LLAVE_DEL_CLIENTE, clientId)) {
        // Sin datos personales: sólo el id del cliente. Una errata en un id sale aquí.
        logger.info('[puerta] clientId sin llave en el mapa: pasa sin comprobar', { clientId: clientId ?? null })
        return true
    }
    let acceso: Acceso
    try {
        acceso = await accesoDe(userId)
    } catch (e) {
        throw new ComprobacionNoDisponible(e)
    }
    if (acceso.baja === true) return bajaPasa
    return acceso.todo || acceso.llaves.has(LLAVE_DEL_CLIENTE[clientId])
}

/**
 * Lo mismo para la web (callback, `?op=`, exchange): FALLA CERRADO. Si no se puede
 * comprobar, no entra y queda en el registro.
 */
export async function puedeEntrar(userId: string, clientId: string | null | undefined): Promise<boolean> {
    try {
        return await comprobarEntrada(userId, clientId, { bajaPasa: false })
    } catch (e) {
        logger.error('[puerta] no se pudo comprobar la llave de entrada: se deniega', {
            clientId,
            userId,
            error: (e as Error).message,
        })
        return false
    }
}

/**
 * A dónde se lleva a quien no entra: una pantalla de Accesos que NO vuelve a lanzar el
 * flujo (la galleta de flujo ya está borrada), así que no hay bucle posible. El nombre
 * de la aplicación sale de `NOMBRE_DEL_CLIENTE`, nunca del texto de la dirección.
 */
export const urlSinPermiso = (clientId: string) => `/sin-permiso?app=${encodeURIComponent(clientId)}`
