# Dispositivos en Accesos — lo que tiene que hacer cada aplicación

**Estado: PROPUESTO (29/10/2026). Todavía NO está en producción.** Este documento es el contrato para las
aplicaciones con aparatos propios (Reparto, CRM, las que vengan). Cuando Accesos lo tenga desplegado se avisa y se
pone aquí la fecha. Hasta entonces no hay que cambiar nada en el CRM.

## Para qué

Hoy un desarrollador o un administrador no puede ver **qué aparatos hay, de quién son, qué aplicación y versión
tienen instalada, cuándo trabajaron por última vez ni si funcionan**. Cada aplicación guarda su propio trabajo
(lo que subió, lo que le rechazaron), pero nadie junta la identidad del aparato.

La idea, en dos capas que no se mezclan:

- **Accesos** guarda *quién y qué es* el aparato (persona, aplicación, plataforma, versión **actual**, equipo,
  sucursal, última vez visto, estado) y tiene la pantalla **«Dispositivos»** con **una pestaña por aplicación**.
  Se puede ver, poner nombre, cerrar la sesión de un aparato o bloquearlo.
- **Cada aplicación** guarda *qué hizo* (subidas, rechazos, errores, pendientes) en su propia base. En su pestaña
  de Accesos aparece lo que el aparato informó de sí mismo, y un botón **«Ver actividad»** que lleva a la pantalla
  de detalle de la propia aplicación.

## Qué tiene que hacer una aplicación (tres cosas, de menor a mayor)

### 1 · Identidad del aparato — OBLIGATORIA, sin llamadas nuevas

El aparato ya renueva su token con `POST /api/auth/refresh` (cada ≤15 min mientras se usa) y ya manda su
`User-Agent`. Solo hay que **añadir dos cabeceras en esa misma llamada** (y en el `POST /api/auth/token` del primer
acceso):

| Cabecera | Valor | Ejemplo |
|---|---|---|
| `User-Agent` | `<Aplicación>/<versión> (<Plataforma>)` — **ya lo manda Reparto así** | `ProcovarCRM/2.3.1 (Android)` |
| `X-Aparato-Id` | **UUID v7** (no v4) **estable de esta instalación**: se genera la primera vez que arranca la app, se guarda en sus preferencias y no cambia nunca (ni al renovar ni al actualizar). Si se reinstala, es otro aparato. Un id que no sea un v7 bien formado **no se registra** (el aparato sigue funcionando, pero no aparece en Dispositivos). El CRM puede usar tal cual el id de instalación que ya tiene | `0192f3c4-8a3b-7d0e-9d62-6a1f3b6f2c10` |
| `X-Aparato-Nombre` | *(opcional)* nombre legible del equipo, 1–80 caracteres, sin datos personales | `Samsung A14 de Palma` |

Plataforma: una de `Android`, `Windows`, `iOS`, `macOS`, `Linux`. Versión: la de `pubspec`/`package.json` tal cual
(`1.0.47`); si hay número de compilación, `1.0.47+48`.

Con eso Accesos crea la fila del aparato la primera vez y la **actualiza en cada renovación** (versión, plataforma,
IP, última vez visto). No cambia la respuesta de `/refresh`, y si la cabecera no viene todo sigue funcionando
igual: el aparato simplemente aparece como «sin identificar» (se sigue viendo la sesión, como hoy).

### 2 · Estado de trabajo — RECOMENDADA

Para que la pestaña diga **si el aparato funciona**, la aplicación manda su estado en cada ciclo de
sincronización (o cada vez que trabaja):

```
POST https://auth.procovar.cloud/api/dispositivos/estado
Authorization: Bearer <access token de la aplicación>
X-Aparato-Id: <el mismo UUID>
Content-Type: application/json

{
  "ultimaDescarga": "2026-10-29T14:02:11Z",   // última vez que bajó datos del servidor (ISO 8601, UTC)
  "ultimaSubida":   "2026-10-29T14:02:15Z",   // última vez que subió algo con éxito
  "pendientes":     0,                          // apuntes/cambios en su cola sin subir
  "rechazados":     0,                          // apuntes que el servidor rechazó y siguen sin resolver
  "ultimoError":    null                        // texto corto del último fallo (≤200 car.), o null
}
```

Todos los campos son opcionales; un campo ausente no borra el valor anterior. **Respuestas:**
`200 { "ok": true, "revocado": false }` · `401` token no válido o caducado · `429` demasiadas llamadas (máx. 1 por
minuto y aparato; las demás se ignoran con 200) · `503` Accesos no pudo comprobar.

**No es crítico y no debe molestar al trabajo:** timeout de 5 s, **sin reintentos en bucle**, nunca bloquea ni
rompe un ciclo; si falla, se vuelve a intentar en el siguiente. Si la respuesta trae `"revocado": true`, un
administrador cerró ese aparato desde Accesos: la app cierra sesión (igual que si `/refresh` diera 401).

### 3 · Detalle por aplicación — OPCIONAL

Cada aplicación puede tener su propia pantalla «actividad de un aparato» (qué subió, qué falló, cuándo, con el
motivo literal). Accesos solo necesita **una dirección**: se la apunta un administrador en la ficha de la
aplicación (`ClientApp.dispositivosUrl`) con el hueco `{aparatoId}`:

```
https://crm.procovar.cloud/dispositivos/{aparatoId}
```

El botón «Ver actividad» de la pestaña abre esa dirección. La pantalla la protege la propia aplicación (con la
sesión de Accesos, como todo). Reparto ya tiene su sincronización con esos datos y hará la suya como ejemplo.

## Cómo se ve en Accesos

Pantalla **«Dispositivos»** (solo DESARROLLADOR, SUPER ADMIN y ADMINISTRADOR de su sucursal; el administrador de
sucursal solo ve los de su sucursal), una pestaña por aplicación (`Reparto`, `CRM`, …), con filtro por sucursal y
persona. Por aparato:

- **Persona** (con su nombre), **sucursal**, **aplicación y versión**, **plataforma**, **equipo**.
- **Visto por última vez**, última descarga, última subida (los dos últimos, si la app los informa).
- **Pendientes** y **rechazados**, y el **último error**.
- Una marca de color: *funciona* (visto hace poco y sin rechazados), *atascado* (pendientes o rechazados sin
  resolver / lleva mucho sin subir), *callado* (no se ve desde hace días).
- Acciones: **ponerle nombre**, **cerrar su sesión** (el aparato deja de renovar y sale), **bloquear** (no vuelve
  a entrar con ese `X-Aparato-Id` hasta que se desbloquee), **Ver actividad**.

## Qué guarda Accesos (para que quede dicho)

Tabla `dispositivo`: persona, aplicación (`clientId`), `aparatoId`, plataforma, versión, equipo, sucursal, última
IP, primera y última vez visto, y el estado informado (`ultimaDescarga`, `ultimaSubida`, `pendientes`,
`rechazados`, `ultimoError`), más `revocadoAt`/`revocadoPor`. **No guarda** el contenido del trabajo, ni tokens, ni
datos de clientes. La IP y el `User-Agent` ya se guardan hoy en la sesión.

## Lo que NO hay que hacer

- No mandar tokens, contraseñas, nombres de clientes ni datos de negocio en las cabeceras ni en `ultimoError`.
- No usar el `aparatoId` como credencial: identifica, no autentica.
- No reintentar en bucle ni convertir un fallo del latido en un fallo de la aplicación.
- No generar un `X-Aparato-Id` nuevo en cada arranque: tiene que sobrevivir a reinicios y actualizaciones.

## Orden de puesta en producción

1. **Accesos** (migración aditiva `dispositivo` + el reconocimiento de las cabeceras en `/refresh` y `/token` +
   `POST /api/dispositivos/estado` + la pantalla). Es el login de todo: no se despliega sin orden de Jose.
2. **Reparto** (versión nueva de la APK y el escritorio: `X-Aparato-Id`, estado y su pantalla de actividad).
3. **CRM**: cuando Amado quiera. Hasta que Accesos esté desplegado, mandar las cabeceras no hace nada (se ignoran).
   Después, los pasos 1 y 2 de arriba; el 3 es opcional.

Preguntas o cambios del contrato: a Jose (Accesos y Reparto son suyos; el CRM lo escribe Amado).
