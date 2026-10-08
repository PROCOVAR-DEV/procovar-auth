import { PERMISSION_CATALOG } from './permissions.catalog'

/**
 * The six Procovar roles. One catalog for all eight sucursales.
 *
 * The names are spelled EXACTLY as PEDIDO already spells them, because PEDIDO
 * compares the role it receives against these strings. Renaming one here to
 * something tidier (`super-admin`) would mean adding a translation table in
 * every app, and a translation table is one more thing that can disagree.
 *
 * What each role may do is only SEEDED here. Once it is in the database it is
 * edited from the permissions screen — Jose asked to manage permissions without
 * touching code. So treat this file as the starting point, not the law: a
 * deployment must never overwrite what somebody changed on screen (see
 * `syncRbac`, which only ADDS what is missing from a role it just created).
 */
/**
 * ECONOMICA, ANALISTA y LOGISTICO van AL FINAL, y no es cosmético: este array
 * decide DOS cosas a la vez.
 *
 *   `PRECEDENCE`  qué rol gana para el único `member.role` que guarda better-auth
 *                 cuando alguien lleva varios.
 *   `ESCALAFON`   quién está por encima de quién, o sea a quién puede repartir cada
 *                 uno (ver `escalafon.ts`).
 *
 * Al final, añadirle uno de estos tres a alguien NUNCA le baja el rol con el que ya
 * trabaja: una Administradora que además sea ECONOMICA sigue saliendo como
 * ADMINISTRADOR por todas partes. Metiéndolos en medio, se lo habrían comido — y
 * eso no falla, simplemente le desaparecen pantallas un martes.
 *
 * OJO con ANALISTA cuando se le pongan los permisos. Si acaba viendo las OCHO
 * sucursales —que es lo que hace hoy el rol `analitico` interno de Analitics, con
 * su comodín—, estando al final del escalafón lo podría repartir cualquiera de
 * sucursal. Ese día hay que SUBIRLO, y subirlo toca la precedencia: hay que mirar
 * las dos cosas, no una.
 */
export const SYSTEM_ROLE_NAMES = ['DESARROLLADOR', 'SUPER ADMIN', 'ADMINISTRADOR', 'GERENTE', 'SUPERVISOR', 'GESTOR', 'OPERADOR', 'ECONOMICA', 'ANALISTA', 'LOGISTICO'] as const
export type SystemRoleName = (typeof SYSTEM_ROLE_NAMES)[number]

/** The role a new member gets when nobody said otherwise: the most limited one. */
export const ROL_MINIMO: SystemRoleName = 'GESTOR'

/**
 * Which role wins when a person holds several, for the single `member.role`
 * string better-auth keeps. Most powerful first.
 */
export const PRECEDENCE: readonly string[] = SYSTEM_ROLE_NAMES

/**
 * Qué es cada rol, dicho para quien lo va a repartir.
 *
 * Cada una dice TRES cosas, en este orden: quién es esa persona en la práctica, qué
 * puede hacer, y dónde está el límite. Antes decían sólo lo del medio —"Global. Ve y
 * gestiona todas las sucursales"— y así no se puede elegir: quien reparte accesos no
 * está mirando una lista de permisos, está pensando en una persona concreta y en si le
 * da esto o lo de abajo.
 *
 * El límite es la parte que importa y la que faltaba. Un rol se elige tanto por lo que
 * deja hacer como por lo que impide, y si sólo se cuenta la mitad buena, se acaba dando
 * de más por si acaso.
 */
export const ROLE_DESCRIPTIONS: Record<SystemRoleName, string> = {
  DESARROLLADOR:
    'Quien mantiene la plataforma por dentro. Puede todo lo del Super Admin y además el módulo de Avisos: tipos, plantillas y canales de notificación. No es un rol de negocio y no se pide: se da a mano y a muy poca gente, porque desde aquí se tocan cosas que afectan a las ocho sucursales a la vez.',
  'SUPER ADMIN':
    'Manda en todas las sucursales. Crea sucursales y personas, reparte y quita accesos, y ve los datos de cualquiera. No pertenece a ninguna sucursal en concreto — precisamente por eso las ve todas.',
  ADMINISTRADOR:
    'Manda, pero sólo donde está dado de alta. Dentro de sus sucursales hace lo mismo que un Super Admin: personas, accesos y configuración. Fuera de ellas no ve nada, ni siquiera que existen.',
  GERENTE:
    'Lleva el día a día de su sucursal. Ve todos los pedidos, clientes y vendedores, y los informes completos. Lo que no puede es repartir accesos ni cambiar la configuración: para eso está el Administrador.',
  SUPERVISOR:
    'Tiene gestores a su cargo. Ve y trabaja lo suyo y lo de ellos, dentro de su sucursal. No alcanza al resto de la sucursal, sólo a su gente.',
  GESTOR:
    'El vendedor. Ve y trabaja únicamente lo suyo: sus clientes, sus pedidos, sus comisiones. Es el rol que se da por defecto a quien entra nuevo, porque es el que menos abarca.',
  OPERADOR:
    'El de facturación. Lee los pedidos de su sucursal y los marca como completados, que es su trabajo entero. Sin informes y sin ver nada de otras sucursales.',
  ECONOMICA:
    'La económica de su sucursal. Lleva el inventario de activos fijos: los da de alta, los mueve, los exporta y mantiene el catálogo de áreas, ubicaciones y responsables. No toca pedidos ni clientes, y no ve nada de otras sucursales.',
  ANALISTA:
    'Todavía sin permisos: el rol existe para poder asignarlo, pero hasta que se le diga qué puede ver no abre ninguna pantalla. Quien lo lleve entra y no encuentra nada, y eso es a propósito — un rol vacío no da de más por accidente.',
  LOGISTICO:
    'El logístico de su sucursal. Arma las rutas y reparte: asigna y cierra los repartos, calcula las rutas y consulta los vehículos, los productos y los informes de reparto. No toca pedidos ni clientes y no ve nada de otras sucursales.',
}

const allKeys = () => PERMISSION_CATALOG.filter((p) => !p.isDeprecated).map((p) => p.key)

/** Lo mínimo para trabajar: leer lo suyo. */
const GESTOR_KEYS = [
  // Entrar donde ya trabajaba. La llave de entrada es nueva y sin ella un rol que
  // podía leer pedidos se quedaría en la puerta el día que alguna aplicación
  // empiece a mirarla.
  //
  // Sin `delivery.entrar` ni `reparto.read` desde el 08/10/2026: a Reparto sólo
  // entran ADMINISTRADOR, SUPER ADMIN, DESARROLLADOR y LOGISTICO (Jose: «los
  // logísticos, admins, superadmins y desarrolladores son los únicos que pueden
  // entrar a Reparto»). OPERADOR y SUPERVISOR heredan de aquí, así que esto los
  // quita a los tres de una vez.
  'pedido.entrar',
  'pedido.read',
  'pedido.copy',
  'panel.read',
  'cliente.read',
  'vendedor.read',
  'comision.read',
]

/**
 * Quién LLEVA código de vendedor.
 *
 * Aparte y no dentro de GESTOR_KEYS porque OPERADOR hereda esas claves enteras
 * (`...GESTOR_KEYS`) y un operador no vende: le habría salido el campo en su
 * formulario sin tener nunca un código que poner.
 *
 * Los que venden son el gestor y el supervisor — que en esta operación son la misma
 * figura con distinto alcance. Y el administrador o el super admin no: mandan, no
 * venden.
 */
const VENDE = 'vendedor.codigo'

/**
 * El Operador factura: lee los pedidos de su sucursal, los completa y copia los
 * datos al sistema de facturación. Y nada más.
 *
 * Sin informes en NINGUNA aplicación y sin importar: "no, reportes no, pedidos
 * nada más, como está hasta ahora está correcto" (Jose, 11/08). Es exactamente
 * lo que hace hoy en PEDIDO, así que conectar PEDIDO a este login no le cambia
 * el día a día a ninguna operadora.
 */
const OPERADOR_KEYS = [
  ...GESTOR_KEYS,
  'pedido.complete',
  'pedido.edit',
  'pedido.export',
  'cliente.create',
  'cliente.edit',
  'cliente.export',
]

/**
 * El Supervisor saca adelante el trabajo de la sucursal: importa, saca
 * informes y lleva a los vendedores. Lo que NO hace es repartir accesos — para
 * eso está el Administrador — ni, desde el 08/10/2026, mover el reparto: eso es
 * del LOGISTICO (ver `REPARTO_KEYS`).
 */
const SUPERVISOR_KEYS = [
  ...OPERADOR_KEYS,
  'analitics.entrar',
  'ccsa.entrar',
  // Rutas: mira el cumplimiento de SUS vendedores y saca el reporte. La bandeja y
  // Administración son de quien lleva las carpetas, no suyas.
  'rutas.entrar',
  'rutas.calendario',
  'rutas.visor',
  'rutas.reporte',
  'pedido.import',
  'reporte.read',
  'reporte.export',
  'vendedor.create',
  'vendedor.edit',
  'vendedor.manage',
  'analitics.read',
  'analitics.export',
  'analitics.gestor',
  'analitics.producto',
  'analitics.meta',
  'ccsa.read',
  'ccsa.export',
  'ccsa.territorio',
  'member.read',
  'usuariopedido.read',
  'integracion.read',
  'sincronizacion.run',
]

/**
 * El Administrador manda en SU sucursal: todo lo que se hace ahí dentro,
 * incluido dar de alta gente, ponerle rol y mirar la auditoría.
 *
 * Se le quedan fuera las cosas que son de TODA la empresa, no de una sucursal:
 * el catálogo de roles (tocar "OPERADOR" lo cambia en las ocho), el alta de
 * aplicaciones, y crear o borrar sucursales.
 */
const ADMIN_EXCLUIDOS_BASE = [
  'app.manage',
  'role.create',
  'role.edit',
  'role.delete',
  'organization.create',
  'organization.delete',
] as const

const ADMIN_EXCLUIDOS = new Set<string>(ADMIN_EXCLUIDOS_BASE)

/**
 * TODAS las llaves de Reparto: el servicio `delivery` entero, la de entrar incluida.
 *
 * Se saca del catálogo y no de una lista a mano para que una llave nueva de Reparto
 * quede excluida del Gerente sin acordarse. Comprobado el 08/10/2026 que ninguna otra
 * aplicación lee estas claves (ni PEDIDO, ni Analitics, ni Rutas, ni Notify, ni el
 * delivery viejo): sólo Accesos las reparte, y el reparto nuevo decide por el NOMBRE
 * del rol que viene en el token.
 */
export const REPARTO_KEYS: readonly string[] = PERMISSION_CATALOG
  .filter((p) => p.service === 'delivery')
  .map((p) => p.key)

/**
 * El Gerente está por encima del Supervisor y por debajo del Administrador: ve
 * TODO lo de su sucursal, no solo lo de un equipo, y lleva el trabajo diario.
 *
 * Lo que se le quita respecto al Administrador es lo que reparte poder o cambia
 * cómo funciona el sistema: dar de alta gente y ponerle rol, la auditoría, las
 * integraciones y la configuración. "Como un admin pero sin las cosas
 * complejas, solo gestionar cosas sencillas" (Jose, 15/08).
 */
const GERENTE_EXCLUIDOS = new Set<string>([
  ...ADMIN_EXCLUIDOS_BASE,
  // Reparto ya no es suyo (08/10/2026). El Gerente se sirve de `allKeys()`, así que
  // sin esto seguiría recibiendo cada llave de Reparto que se añada al catálogo.
  ...REPARTO_KEYS,
  // Repartir accesos es del Administrador.
  'member.invite',
  'member.remove',
  'member.password',
  'member.session',
  // Y la trastienda: auditoría, integraciones y tocar la sucursal.
  'audit.read',
  'audit.export',
  'integracion.manage',
  'organization.edit',
  'usuariopedido.manage',
])

/** Ni el Administrador ni el Gerente venden: mandan. */
const NO_VENDEN = new Set([VENDE])

/**
 * Lo que SOLO ve el Desarrollador — ni el Super Admin.
 *
 * Es la única excepción a "el Super Admin lo ve todo", y es a propósito.
 * Configurar los tipos, plantillas y canales de `procovar-notify` no es gestionar
 * una sucursal: es trastienda técnica, y tocarla sin saber deja a la gente sin
 * recibir avisos **sin que salte ningún error** — el envío sigue devolviendo 202
 * y nadie se entera hasta que alguien pregunta por qué no le llegó nada.
 *
 * Si mañana hay que abrírselo al Super Admin, se le da desde la pantalla de
 * Roles: `syncRbac` sólo AÑADE lo que falta a un rol que acaba de crear, así que
 * no le va a quitar lo que se conceda a mano.
 */
const SOLO_DESARROLLADOR = new Set<string>(
  PERMISSION_CATALOG.filter((p) => p.service === 'avisos').map((p) => p.key),
)

export function systemRolePermissionKeys(role: string): string[] {
  switch (role) {
    // Todo, sin excepciones. Es el único que lleva las claves de Avisos.
    case 'DESARROLLADOR': return allKeys()
    case 'SUPER ADMIN': return allKeys().filter((k) => !SOLO_DESARROLLADOR.has(k))
    case 'ADMINISTRADOR': return allKeys().filter((k) => !ADMIN_EXCLUIDOS.has(k) && !NO_VENDEN.has(k) && !SOLO_DESARROLLADOR.has(k))
    case 'GERENTE': return allKeys().filter((k) => !GERENTE_EXCLUIDOS.has(k) && !NO_VENDEN.has(k) && !SOLO_DESARROLLADOR.has(k))
    case 'SUPERVISOR': return [...new Set([...SUPERVISOR_KEYS, VENDE])]
    case 'OPERADOR': return [...new Set(OPERADOR_KEYS)]
    case 'GESTOR': return [...GESTOR_KEYS, VENDE]
    /*
     * La económica: AFT entero y nada más.
     *
     * «La económica debe de ver el AFT» (Jose, 30/09/2026). Se le da la aplicación
     * completa —incluido `aft.manage`, el catálogo— porque es quien inventaría: si
     * pudiera dar de alta un activo pero no el área donde va, se queda a medias y
     * tiene que buscar a alguien cada vez, que es justo lo que se vino a quitar.
     *
     * Y NADA de pedidos ni clientes: no es su trabajo. Si alguna hace además otra
     * cosa, se le añade el rol que toque encima; los permisos se suman.
     */
    case 'ECONOMICA': return PERMISSION_CATALOG.filter((p) => p.service === 'aft' && !p.isDeprecated).map((p) => p.key)
    /*
     * ANALISTA nace VACÍO, a propósito.
     *
     * Jose lo pidió el 30/09/2026 y dijo «después te doy los permisos». Un rol sin
     * claves se puede crear y repartir hoy sin abrirle nada a nadie; inventarle yo
     * unas cuantas «mientras tanto» es dar acceso que no autorizó nadie, y de los
     * que después no se acuerda ni quien los puso.
     *
     * Cuando lleguen: si incluyen ver varias sucursales, hay que mirar también su
     * sitio en SYSTEM_ROLE_NAMES (ver la nota de arriba).
     */
    case 'ANALISTA': return []
    /*
     * El logístico: Reparto, y nada más.
     *
     * «Los logísticos, admins, superadmins y desarrolladores son los únicos que pueden
     * entrar a Reparto; a los otros quítales esos permisos» (Jose, 08/10/2026), y «el
     * LOGISTICO lo mandé crear hace años, al igual que el económico».
     *
     * Lleva EXACTAMENTE lo de Reparto que tenía el Supervisor antes de quitárselo, más
     * la llave de entrar que traía el Gestor. Y NO `reparto.sync`: lanzar la
     * sincronización es de quien administra (Administrador, Gerente y los de arriba la
     * tenían; el Supervisor nunca), ningún otro sistema la lee, y un logístico arma
     * rutas, no toca la plomería. Si algún día hace falta, se le da desde la pantalla de
     * Roles. Por lo mismo, sin `vehiculo.manage` ni `almacen.manage`: el Supervisor
     * tampoco las tuvo, y gestionar la flota y los productos es de quien administra.
     *
     * Como ECONOMICA, no lleva `vendedor.codigo`: no vende. Y nada de pedidos ni
     * clientes — si además hace otra cosa, se le añade el rol que toque encima.
     */
    case 'LOGISTICO': return [
      'delivery.entrar',
      'reparto.read',
      'reparto.assign',
      'reparto.complete',
      'reparto.report',
      'ruta.read',
      'ruta.manage',
      'vehiculo.read',
      'almacen.read',
    ]
    default: return []
  }
}
