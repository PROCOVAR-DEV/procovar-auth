/**
 * Traducir lo que guarda la auditoría a algo que se pueda leer.
 *
 * En la base cada apunte es una clave técnica: `member.create`, `role.reset`,
 * `session.revoke`. Eso está bien para buscar y agrupar, y muy mal para
 * responder la pregunta por la que alguien abre esta pantalla, que casi siempre
 * es "¿quién le quitó el acceso a fulana?".
 *
 * Aquí se traduce a una frase. La clave técnica se sigue enseñando al lado: es
 * lo que hay que citar cuando se pide ayuda, y esconderla obligaría a adivinar.
 */

export interface AccionDescrita {
  /** La frase que se lee. */
  texto: string;
  /** Para colorear: qué clase de cosa es. */
  tipo: 'alta' | 'baja' | 'cambio' | 'acceso';
}

const ACCIONES: Record<string, AccionDescrita> = {
  'member.create': { texto: 'Dio de alta a una persona en una sucursal', tipo: 'alta' },
  'member.remove': { texto: 'Dio de baja a una persona de una sucursal', tipo: 'baja' },
  'member.roles': { texto: 'Cambió los roles de una persona', tipo: 'cambio' },

  'role.reset': { texto: 'Devolvió un rol a sus permisos de fábrica', tipo: 'cambio' },
  'role.create': { texto: 'Creó un rol', tipo: 'alta' },
  'role.edit': { texto: 'Cambió los permisos de un rol', tipo: 'cambio' },
  'role.delete': { texto: 'Eliminó un rol', tipo: 'baja' },

  'user.admin': { texto: 'Cambió quién es Super Admin', tipo: 'cambio' },
  'user.delete': { texto: 'Eliminó una cuenta', tipo: 'baja' },
  'user.password': { texto: 'Cambió una contraseña', tipo: 'cambio' },

  'session.revoke': { texto: 'Cerró una sesión', tipo: 'acceso' },
  'session.revokeAll': { texto: 'Cerró todas las sesiones de una persona', tipo: 'acceso' },
  'auth.login': { texto: 'Entró en el sistema', tipo: 'acceso' },
  'auth.logout': { texto: 'Salió del sistema', tipo: 'acceso' },
  'auth.code.exchange': { texto: 'Una aplicación comprobó su identidad', tipo: 'acceso' },
  'auth.code.denied': { texto: 'No se le dejó entrar a una aplicación (sin permiso)', tipo: 'acceso' },
  'auth.apk.denied': { texto: 'No se le dejó entrar a la aplicación del reparto (sin permiso)', tipo: 'acceso' },
  'auth.apk.entrega': { texto: 'Dejó su trabajo sin enviar en la bandeja de revisión del reparto', tipo: 'acceso' },
  'auth.apk.entrega_denegada': { texto: 'No se le dejó entregar su trabajo a revisión (reparto)', tipo: 'acceso' },
  'callback.create': { texto: 'Una aplicación pidió identificar a alguien', tipo: 'acceso' },

  'organization.create': { texto: 'Creó una sucursal', tipo: 'alta' },
  'organization.edit': { texto: 'Editó una sucursal', tipo: 'cambio' },
  'organization.delete': { texto: 'Eliminó una sucursal', tipo: 'baja' },

  'app.create': { texto: 'Registró una aplicación', tipo: 'alta' },
  'app.edit': { texto: 'Cambió la configuración de una aplicación', tipo: 'cambio' },
  'app.disable': { texto: 'Desactivó una aplicación', tipo: 'baja' },
};

/**
 * Una acción que no esté en la lista se enseña tal cual, no se esconde.
 *
 * Un apunte que no sabemos nombrar sigue siendo un apunte: ocultarlo dejaría
 * huecos en el historial justo cuando aparece algo nuevo, que es cuando más
 * importa verlo.
 */
export function describirAccion(action: string): AccionDescrita {
  return ACCIONES[action] ?? { texto: action, tipo: 'cambio' };
}

/** Todas las acciones conocidas, para el desplegable del filtro. */
export function accionesConocidas(): { clave: string; texto: string }[] {
  return Object.entries(ACCIONES)
    .map(([clave, { texto }]) => ({ clave, texto }))
    .sort((a, b) => a.texto.localeCompare(b.texto, 'es'));
}
