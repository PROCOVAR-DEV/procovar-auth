import { prisma } from '@/lib/prisma'

/**
 * QUÉ APLICACIONES LE ENSEÑA «A dónde ir» A CADA PERSONA.
 *
 * Antes se pintaban las nueve a todo el mundo, y quien no tenía permiso para
 * entrar en Analitics veía su tarjeta igual y se enteraba al pulsarla.
 *
 * ## Esto es una comodidad, NO la puerta
 *
 * Que una tarjeta no salga no impide entrar: la puerta de cada aplicación es su
 * propio `verify-session` (ver `docs/PERMISOS-EN-CADA-APLICACION.md`) y el canje de
 * códigos, que no pasan por aquí. Este filtro sólo decide qué se enseña.
 *
 * ## La regla
 *
 * Cada aplicación se abre con SU llave de entrada (`pedido.entrar`, `rutas.entrar`…).
 * Se enseña si la persona la tiene, mirando sus llaves REALES —las de su rol por
 * defecto más las de todos los roles de sus membresías— y NO el nombre de ningún rol.
 * Así, cuando se le quita o se le da una llave a un rol desde Roles y permisos (o en
 * `system-roles.ts`), esta pantalla cambia sola, sin tocar nada aquí.
 */

/** Una tarjeta de «A dónde ir». `clientId` es el de `APLICACIONES` en `rbac/procovar.ts`. */
export interface Destino {
    clientId: string
    href: string
    icono: string
    titulo: string
    descripcion: string
    externo?: boolean
}

/**
 * Todo el ecosistema, no sólo las cuatro de siempre.
 *
 * Faltaban cinco de las nueve —Rutas, Entrega, Caja, Traslado y el Portal—, así que
 * quien entraba aquí veía media plataforma y tenía que saberse las direcciones de
 * memoria para llegar al resto. Comprobadas una a una antes de ponerlas: todas responden.
 *
 * n8n se queda fuera a propósito. Es la herramienta de automatizaciones, no una
 * aplicación de negocio: quien la necesita sabe dónde está, y ponerla aquí invita a
 * entrar a quien no tiene por qué.
 *
 * Activos fijos (AFT) se añadió con el filtro: tiene su `aft.entrar` y es la aplicación
 * de la ECONOMICA, que de otro modo no encontraría aquí NINGUNA de las suyas.
 */
export const APLICACIONES_DE_LA_CASA: Destino[] = [
    {
        clientId: 'pedido',
        href: 'https://pedidos.procovar.cloud',
        icono: 'lucide:clipboard-list',
        titulo: 'PEDIDO',
        descripcion: 'Pedidos, clientes y vendedores.',
        externo: true,
    },
    {
        clientId: 'analitics',
        href: 'https://analitics.procovar.cloud',
        icono: 'lucide:bar-chart-3',
        titulo: 'Analitics',
        descripcion: 'Informes de ventas, gestores y productos.',
        externo: true,
    },
    {
        clientId: 'rutas',
        href: 'https://rutas.procovar.cloud',
        icono: 'lucide:route',
        titulo: 'Rutas',
        descripcion: 'Recorridos de los vendedores sobre el mapa.',
        externo: true,
    },
    {
        clientId: 'delivery',
        href: 'https://delivery.procovar.cloud',
        icono: 'lucide:truck',
        titulo: 'Delivery',
        descripcion: 'Reparto y planificación de rutas.',
        externo: true,
    },
    {
        clientId: 'entrega',
        href: 'https://entrega.procovar.cloud',
        icono: 'lucide:package-check',
        titulo: 'Entrega',
        descripcion: 'Panel de la aplicación de los repartidores.',
        externo: true,
    },
    {
        clientId: 'caja',
        href: 'https://caja.procovar.cloud',
        icono: 'lucide:banknote',
        titulo: 'Caja',
        descripcion: 'Cobros y cierres de caja.',
        externo: true,
    },
    {
        clientId: 'traslado',
        href: 'https://traslado.procovar.cloud',
        icono: 'lucide:arrow-left-right',
        titulo: 'Traslado',
        descripcion: 'Movimientos de mercancía entre sucursales.',
        externo: true,
    },
    {
        clientId: 'ccsa',
        href: 'https://ccsa.procovar.cloud',
        icono: 'lucide:layout-dashboard',
        titulo: 'Tablero Parranda',
        descripcion: 'El tablero de Parranda / CCSA.',
        externo: true,
    },
    {
        clientId: 'aft',
        href: 'https://aft.procovar.cloud',
        icono: 'lucide:archive',
        titulo: 'Activos fijos',
        descripcion: 'Inventario de activos fijos.',
        externo: true,
    },
    {
        clientId: 'portal',
        href: 'https://procovar.cloud',
        icono: 'lucide:home',
        titulo: 'Portal',
        descripcion: 'La entrada común a todo lo demás.',
        externo: true,
    },
]

/**
 * Aplicación → la llave que da entrada, o `null` si no tiene ninguna.
 *
 * Las seis con llave salen de `permissions.catalog.ts` («Una llave por aplicación,
 * aparte de lo que se pueda hacer dentro») y la prueba comprueba que existen ahí.
 *
 * `null` = SIN LLAVE: el catálogo no tiene `entrega.entrar`, `caja.entrar` ni
 * `traslado.entrar`, así que NINGÚN rol tiene registrado acceso a ellas y NO se enseñan
 * (08/10/2026, Jose: «sólo deben mostrarse las aplicaciones a las cuales ese rol tiene
 * acceso, no todas»). Lo ve quien lo ve todo (administrador de sistema). La excepción es
 * el Portal, que es la entrada común y sale a quien tenga alguna llave de entrada. No se
 * inventa una llave que nadie ha repartido: el día que exista, se escribe aquí y ya.
 *
 * Una aplicación que NO esté en este mapa no se enseña (salvo a quien lo ve todo):
 * mejor una tarjeta de menos que una de más. La prueba avisa si se añade una sin mapa.
 */
export const LLAVE_DE_ENTRADA: Readonly<Record<string, string | null>> = {
    pedido: 'pedido.entrar',
    analitics: 'analitics.entrar',
    rutas: 'rutas.entrar',
    delivery: 'delivery.entrar',
    ccsa: 'ccsa.entrar',
    aft: 'aft.entrar',
    entrega: null,
    caja: null,
    traslado: null,
    portal: null,
}

/** La única aplicación sin llave que se enseña a todo el que tenga alguna: el Portal. */
export const ENTRADA_COMUN = 'portal'

/** Lo que se necesita saber de una persona para filtrar: lo ve todo, o estas llaves. */
export interface Acceso {
    todo: boolean
    llaves: ReadonlySet<string>
}

/**
 * Las aplicaciones que le tocan a esta persona.
 *
 *  - `todo` (administrador de sistema): todas.
 *  - Las que tienen llave, sólo si la persona la tiene.
 *  - Las SIN llave (Entrega, Caja, Traslado) NO se enseñan: ningún rol tiene registrado
 *    acceso a ellas. Sólo el Portal, la entrada común, acompaña a quien tenga alguna
 *    llave de entrada.
 *  - Quien no tiene NINGUNA llave de entrada no recibe nada —ni el Portal—: es el rol
 *    vacío (ANALISTA, o alguien sin rol), y la pantalla le dice que pida acceso.
 */
export function aplicacionesVisibles<T extends { clientId: string }>(apps: readonly T[], acceso: Acceso): T[] {
    if (acceso.todo) return [...apps]
    const llaveDe = (a: T) => LLAVE_DE_ENTRADA[a.clientId]
    const tieneAlguna = apps.some((a) => {
        const k = llaveDe(a)
        return typeof k === 'string' && acceso.llaves.has(k)
    })
    if (!tieneAlguna) return []
    return apps.filter((a) => {
        const k = llaveDe(a)
        if (k === null) return a.clientId === ENTRADA_COMUN
        return typeof k === 'string' && acceso.llaves.has(k)
    })
}

/**
 * Las llaves REALES de una persona: las de su rol por defecto más las de los roles de
 * TODAS sus membresías (la unión; los roles sólo suman, no hay «denegar»).
 *
 * `resolveRbac` hace lo mismo pero para UNA sucursal; aquí no hay sucursal elegida —esta
 * pantalla es la de la persona, no la de una sucursal— y se pregunta por todas a la vez.
 * Las filas de `role_permission` que apuntan a un permiso que ya no existe se saltan,
 * igual que allí.
 */
export async function accesoDe(userId: string, isSystemAdmin: boolean): Promise<Acceso> {
    if (isSystemAdmin) return { todo: true, llaves: new Set() }

    const persona = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            defaultRole: { select: { permissions: { select: { permission: { select: { key: true } } } } } },
            members: {
                select: {
                    memberRoles: {
                        select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } },
                    },
                },
            },
        },
    })

    const llaves = new Set<string>()
    const sumar = (permisos: { permission: { key: string } | null }[] | undefined) => {
        for (const p of permisos ?? []) if (p.permission?.key) llaves.add(p.permission.key)
    }
    sumar(persona?.defaultRole?.permissions)
    for (const m of persona?.members ?? []) for (const mr of m.memberRoles) sumar(mr.role.permissions)

    return { todo: false, llaves }
}
