import type { PermissionEntry } from './types'

/**
 * Everything a person can be allowed to do, across every Procovar app.
 *
 * One list, on purpose. Today each app decides for itself who may do what, so
 * "the Operador cannot run reports" lives in PEDIDO's code, "this user only sees
 * Las Tunas" lives in the Parranda dashboard, and nobody can answer "what can
 * Yasmani do?" without reading four codebases. Here the answer is one query.
 *
 * `service` says which app a permission belongs to. It is what lets the same
 * person run reports in Analitics but not in PEDIDO — two keys, not one flag
 * reused.
 *
 * # Sobre el tamaño de esta lista
 *
 * Es larga a propósito. Empezó con treinta claves y se quedaba corta enseguida:
 * un permiso que no existe no es un permiso abierto, es una pared con la que
 * choca alguien un martes por la mañana sin que nadie sepa por qué. Vale más
 * declarar de más —una clave que nadie comprueba todavía no hace daño— que
 * descubrir el hueco cuando una operadora no puede trabajar.
 *
 * A key is `resource.action`, exactly two parts: they are split back out of it
 * and stored as columns.
 *
 * Añadir es seguro y es la forma normal de crecer. QUITAR una clave borra el
 * permiso y deja huérfanas las concesiones que apuntaban a él —la sincronización
 * las limpia—, así que quitar es quitarle el acceso a alguien en silencio. Si la
 * clave sigue nombrada en algún sitio, márcala `isDeprecated` en vez de borrarla.
 */
const e = (
  key: string, group: string, service: string, es: string, en: string,
): PermissionEntry => {
  const [resource, action] = key.split('.')
  return { key, resource, action, service, group, label: { es, en } }
}

export const PERMISSION_CATALOG: PermissionEntry[] = [
  // ══ PEDIDO ═══════════════════════════════════════════════════════════════
  e('pedido.read',     'Pedidos', 'pedido', 'Ver los pedidos', 'View orders'),
  e('pedido.complete', 'Pedidos', 'pedido', 'Completar pedidos', 'Complete orders'),
  e('pedido.edit',     'Pedidos', 'pedido', 'Editar un pedido', 'Edit an order'),
  e('pedido.delete',   'Pedidos', 'pedido', 'Eliminar pedidos', 'Delete orders'),
  e('pedido.import',   'Pedidos', 'pedido', 'Importar pedidos (CSV)', 'Import orders (CSV)'),
  e('pedido.export',   'Pedidos', 'pedido', 'Exportar la lista de pedidos', 'Export the order list'),
  e('pedido.copy',     'Pedidos', 'pedido', 'Copiar al portapapeles para facturar', 'Copy to clipboard for billing'),

  e('cliente.read',   'Clientes', 'pedido', 'Ver los clientes', 'View clients'),
  e('cliente.create', 'Clientes', 'pedido', 'Crear clientes', 'Create clients'),
  e('cliente.edit',   'Clientes', 'pedido', 'Editar clientes', 'Edit clients'),
  e('cliente.delete', 'Clientes', 'pedido', 'Eliminar clientes', 'Delete clients'),
  e('cliente.export', 'Clientes', 'pedido', 'Exportar clientes', 'Export clients'),

  e('vendedor.read',   'Vendedores', 'pedido', 'Ver los vendedores', 'View sellers'),
  e('vendedor.create', 'Vendedores', 'pedido', 'Dar de alta vendedores', 'Create sellers'),
  e('vendedor.edit',   'Vendedores', 'pedido', 'Editar vendedores', 'Edit sellers'),
  e('vendedor.manage', 'Vendedores', 'pedido', 'Dar de baja y asignar gestor', 'Deactivate and assign manager'),

  e('reporte.read',   'Informes', 'pedido', 'Ver los informes', 'View reports'),
  e('reporte.export', 'Informes', 'pedido', 'Exportar informes', 'Export reports'),
  e('panel.read',     'Informes', 'pedido', 'Ver el panel de PEDIDO', 'View the PEDIDO dashboard'),

  e('comision.read',   'Comisiones', 'pedido', 'Ver las comisiones', 'View commissions'),
  e('comision.manage', 'Comisiones', 'pedido', 'Configurar las comisiones', 'Configure commissions'),

  e('usuariopedido.read',   'Usuarios de PEDIDO', 'pedido', 'Ver los usuarios de PEDIDO', 'View PEDIDO users'),
  e('usuariopedido.manage', 'Usuarios de PEDIDO', 'pedido', 'Crear y editar usuarios de PEDIDO', 'Manage PEDIDO users'),

  e('integracion.read',   'Integraciones', 'pedido', 'Ver claves de API y avisos web', 'View API keys and webhooks'),
  e('integracion.manage', 'Integraciones', 'pedido', 'Gestionar claves de API y avisos web', 'Manage API keys and webhooks'),
  e('sincronizacion.run', 'Integraciones', 'pedido', 'Lanzar la sincronización con Parranda', 'Run the Parranda sync'),

  // ══ Analitics ════════════════════════════════════════════════════════════
  e('analitics.read',    'Analítica', 'analitics', 'Ver la analítica', 'View analytics'),
  e('analitics.export',  'Analítica', 'analitics', 'Exportar la analítica', 'Export analytics'),
  e('analitics.gestor',  'Analítica', 'analitics', 'Ver el desglose por gestor', 'View the breakdown by manager'),
  e('analitics.producto', 'Analítica', 'analitics', 'Ver el desglose por producto', 'View the breakdown by product'),
  e('analitics.meta',    'Analítica', 'analitics', 'Ver y fijar metas', 'View and set targets'),
  e('analitics.admin',   'Analítica', 'analitics', 'Configurar la analítica', 'Configure analytics'),

  // ══ Delivery ═════════════════════════════════════════════════════════════
  e('reparto.read',     'Reparto', 'delivery', 'Ver los repartos', 'View deliveries'),
  e('reparto.assign',   'Reparto', 'delivery', 'Asignar repartos', 'Assign deliveries'),
  e('reparto.complete', 'Reparto', 'delivery', 'Cerrar un reparto', 'Close a delivery'),
  e('ruta.read',        'Rutas', 'delivery', 'Ver las rutas', 'View routes'),
  e('ruta.manage',      'Rutas', 'delivery', 'Crear y calcular rutas', 'Create and compute routes'),
  e('vehiculo.read',    'Vehículos', 'delivery', 'Ver los vehículos', 'View vehicles'),
  e('vehiculo.manage',  'Vehículos', 'delivery', 'Gestionar los vehículos', 'Manage vehicles'),
  e('almacen.read',     'Almacén', 'delivery', 'Ver productos y orígenes', 'View products and origins'),
  e('almacen.manage',   'Almacén', 'delivery', 'Gestionar productos y orígenes', 'Manage products and origins'),
  e('reparto.report',   'Reparto', 'delivery', 'Ver los informes de reparto', 'View delivery reports'),
  e('reparto.sync',     'Reparto', 'delivery', 'Lanzar la sincronización', 'Run the sync'),

  // ══ Tablero Parranda ═════════════════════════════════════════════════════
  e('ccsa.read',       'Parranda', 'ccsa', 'Ver el tablero', 'View the dashboard'),
  e('ccsa.export',     'Parranda', 'ccsa', 'Exportar del tablero', 'Export from the dashboard'),
  e('ccsa.territorio', 'Parranda', 'ccsa', 'Elegir el territorio que se mira', 'Choose which territory to view'),
  e('ccsa.admin',      'Parranda', 'ccsa', 'Configurar el tablero', 'Configure the dashboard'),

  // ══ Rutas ════════════════════════════════════════════════════════════════
  //
  // Rutas no estaba en esta lista: sus dos permisos colgaban de Delivery, que es
  // otra aplicación y otras rutas —las del reparto—. Quien venía a quitarle una
  // pantalla a alguien en Rutas no encontraba dónde.
  e('rutas.entrar',      'Entrar', 'rutas', 'Entrar en Rutas', 'Access Rutas'),
  e('rutas.calendario',  'Vistas', 'rutas', 'Ver el calendario de cumplimiento', 'View the compliance calendar'),
  e('rutas.visor',       'Vistas', 'rutas', 'Ver el recorrido de un día en el mapa', "View a day's track on the map"),
  e('rutas.reporte',     'Vistas', 'rutas', 'Ver e imprimir el reporte semanal', 'View and print the weekly report'),
  e('rutas.bandeja',     'Vistas', 'rutas', 'Ver la bandeja de ficheros sin colocar', 'View the unassigned files inbox'),
  e('rutas.administracion', 'Vistas', 'rutas', 'Ver Administración (carpetas y barridos)', 'View Administration'),
  e('rutas.carpeta',     'Administración', 'rutas', 'Dar de alta y quitar carpetas de Drive', 'Add and remove Drive folders'),
  e('rutas.alias',       'Administración', 'rutas', 'Casar dispositivos con vendedores', 'Match devices to sellers'),
  e('rutas.barrido',     'Administración', 'rutas', 'Lanzar un barrido de Drive', 'Run a Drive scan'),

  // ══ AFT (activos fijos) ══════════════════════════════════════════════════
  //
  // El inventario de activos fijos. Nació en Camagüey y por eso su aplicación se
  // llama «AFT Camagüey», pero las claves son de AFT y no de una sucursal: el
  // alcance lo pone la sucursal de la persona, no el permiso.
  //
  // `aft.manage` es el CATÁLOGO —áreas, ubicaciones y responsables—, que es cosa
  // distinta de dar de alta un activo. Quien inventaría necesita lo segundo todos
  // los días y lo primero casi nunca, y hasta ahora AFT los daba juntos: o podías
  // con todo o no podías con nada.
  e('aft.read',   'Activos fijos', 'aft', 'Ver el inventario de activos fijos', 'View the fixed-asset inventory'),
  e('aft.edit',   'Activos fijos', 'aft', 'Dar de alta y editar activos', 'Create and edit assets'),
  e('aft.delete', 'Activos fijos', 'aft', 'Eliminar activos', 'Delete assets'),
  e('aft.export', 'Activos fijos', 'aft', 'Exportar el inventario (Excel y PDF)', 'Export the inventory (Excel and PDF)'),
  e('aft.manage', 'Activos fijos', 'aft', 'Gestionar áreas, ubicaciones y responsables', 'Manage areas, locations and custodians'),

  // ══ Entrar en cada aplicación ════════════════════════════════════════════
  //
  // Una llave por aplicación, aparte de lo que se pueda hacer dentro. Es lo que
  // permite decir "esta persona no entra en Analitics" de una sola vez, en vez de
  // ir apagando sus permisos uno a uno y descubrir el que se quedó encendido.
  e('pedido.entrar',    'Entrar', 'pedido', 'Entrar en PEDIDO', 'Access PEDIDO'),
  e('analitics.entrar', 'Entrar', 'analitics', 'Entrar en Analitics', 'Access Analitics'),
  e('delivery.entrar',  'Entrar', 'delivery', 'Entrar en Delivery', 'Access Delivery'),
  e('ccsa.entrar',      'Entrar', 'ccsa', 'Entrar en el Tablero Parranda', 'Access the Parranda dashboard'),
  e('aft.entrar',       'Entrar', 'aft', 'Entrar en Activos Fijos', 'Access Fixed Assets'),

  // ══ Las pantallas de Accesos ═════════════════════════════════════════════
  e('auth.sucursales',   'Vistas', 'auth', 'Ver Sucursales', 'View Sucursales'),
  e('auth.personas',     'Vistas', 'auth', 'Ver Personas', 'View People'),
  e('auth.roles',        'Vistas', 'auth', 'Ver Roles y permisos', 'View Roles and permissions'),
  e('auth.auditoria',    'Vistas', 'auth', 'Ver Auditoría', 'View the audit log'),
  e('auth.aplicaciones', 'Vistas', 'auth', 'Ver Aplicaciones', 'View Applications'),

  // ══ Accesos (esta misma aplicación) ══════════════════════════════════════
  e('member.read',       'Personas', 'auth', 'Ver las personas de la sucursal', 'View members'),
  e('member.invite',     'Personas', 'auth', 'Dar de alta personas', 'Add people'),
  e('member.remove',     'Personas', 'auth', 'Dar de baja personas', 'Remove people'),
  e('member.assignRole', 'Personas', 'auth', 'Asignar roles a las personas', 'Assign roles'),
  e('member.password',   'Personas', 'auth', 'Cambiarle la contraseña a alguien', "Change someone's password"),
  e('member.session',    'Personas', 'auth', 'Cerrarle la sesión a alguien', "Close someone's session"),
  // No es un permiso de "puede hacer": marca QUÉ ROLES VENDEN.
  //
  // El código de vendedor sólo lo llevan quienes venden —gestor y supervisor—; un
  // operador o un administrador no tienen. En vez de escribir esa lista dentro del
  // formulario, se cuelga del rol: el día que aparezca otro rol que venda, se le da
  // este permiso desde Roles y el campo sale solo, sin tocar código.
  e('vendedor.codigo',   'Personas', 'auth', 'Lleva código de vendedor', 'Has a seller code'),

  e('role.read',   'Roles y permisos', 'auth', 'Ver los roles', 'View roles'),
  e('role.create', 'Roles y permisos', 'auth', 'Crear roles', 'Create roles'),
  e('role.edit',   'Roles y permisos', 'auth', 'Editar los permisos de un rol', "Edit a role's permissions"),
  e('role.delete', 'Roles y permisos', 'auth', 'Eliminar roles', 'Delete roles'),

  e('organization.read',   'Sucursales', 'auth', 'Ver las sucursales', 'View sucursales'),
  e('organization.edit',   'Sucursales', 'auth', 'Editar una sucursal', 'Edit a sucursal'),
  e('organization.create', 'Sucursales', 'auth', 'Crear sucursales', 'Create sucursales'),
  e('organization.delete', 'Sucursales', 'auth', 'Eliminar sucursales', 'Delete sucursales'),

  // Quién entró, qué tocó y desde dónde. Sin esto no se puede responder qué
  // pasó con un pedido cuando alguien lo niega.
  e('audit.read',   'Auditoría', 'auth', 'Ver la auditoría', 'View the audit log'),
  e('audit.export', 'Auditoría', 'auth', 'Exportar la auditoría', 'Export the audit log'),

  e('app.read',   'Aplicaciones', 'auth', 'Ver las aplicaciones registradas', 'View registered applications'),
  e('app.manage', 'Aplicaciones', 'auth', 'Registrar y configurar aplicaciones', 'Register and configure applications'),

  // ══ Avisos (procovar-notify) ═════════════════════════════════════════════
  //
  // El servicio de notificaciones: avisos.procovar.cloud para la pantalla,
  // avisos-api.procovar.cloud para la API.
  //
  // Estas claves NO se le dan a ningún rol de los seis, NI SIQUIERA al SUPER
  // ADMIN. Son de DESARROLLADOR y solo de él. Es deliberado y es la única
  // excepción a "el super admin lo ve todo": configurar plantillas y canales de
  // aviso es trastienda técnica, no gestión de una sucursal, y quien la toca sin
  // saber deja a la gente sin recibir nada sin que salte ningún error.
  e('avisos.entrar',  'Avisos', 'avisos', 'Entrar en Avisos', 'Access Avisos'),
  e('avisos.read',    'Avisos', 'avisos', 'Ver los avisos enviados y su estado', 'View sent notifications and their status'),
  e('avisos.send',    'Avisos', 'avisos', 'Enviar y cancelar avisos', 'Send and cancel notifications'),
  e('avisos.manage',  'Avisos', 'avisos', 'Configurar tipos, plantillas y canales', 'Configure types, templates and channels'),
]
