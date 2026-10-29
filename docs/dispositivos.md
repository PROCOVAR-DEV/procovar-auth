# Dispositivos en Accesos — lo que tiene que hacer cada aplicación

**Estado (29/10/2026): IMPLEMENTADO Y PROBADO en la rama `feat/dispositivos`; falta DESPLEGAR** (Accesos es el login de todo: no
se despliega sin orden de Jose; la migración se probó sobre una base nueva con las 26 migraciones y sin desviaciones). Este
documento es el contrato para las aplicaciones con aparatos propios (Reparto, CRM, las que vengan). Cuando esté en producción se
avisa y se pone aquí la fecha. Hasta entonces mandar las cabeceras no hace nada (se ignoran sin daño).

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

## Un mismo aparato, VARIAS aplicaciones (Jose, 29/10/2026)

Un teléfono o un PC puede tener **Reparto y el CRM a la vez**. Es **UN aparato**, no una ficha por aplicación: Accesos guarda el aparato una
sola vez (`dispositivo`, único por `aparatoId`: modelo, plataforma, nombre) y **cuelga de él cada aplicación en la que está**
(`dispositivo_app`: versión, sucursal, sesión, estado de trabajo y bloqueo de ESA aplicación). La pantalla enseña el aparato en la pestaña de
cada aplicación, con «También en CRM» si está en más de una.

- **Para que dos aplicaciones sean el mismo aparato tienen que mandar el MISMO `X-Aparato-Id`.** Si cada APK genera el suyo, Accesos ve dos
  aparatos distintos y no puede unirlos solo. (Cómo compartirlo es cosa de cada plataforma: en un mismo teléfono, una cabecera derivada
  del dispositivo y no de la instalación; en Windows, un fichero común.)
- **Bloquear y cerrar sesión son POR APLICACIÓN**: el CRM bloquea su APK en un teléfono sin dejar sin entrar a Reparto en ese mismo
  teléfono. El **nombre** es del aparato: se lo ve igual en todas.
- La lista de servicio (`GET /api/service/dispositivos`) devuelve **solo la fila de TU aplicación**: el CRM no ve que el aparato también
  está en Reparto.

## Un mismo PC, VARIAS cuentas (Jose, 29/10/2026)

Un aparato lo pueden usar varias personas, y hay que saber **cada cuenta que entró**, aunque sea el mismo ordenador. Por eso, además del
aparato y de su paso por cada aplicación, Accesos guarda **una fila por cada cuenta que ha entrado en cada aplicación**
(`dispositivo_persona`: primera vez, última vez y versión con la que entró). `dispositivo_app.userId` es solo la **última** cuenta; el
historial de quién lo usó está en las filas de cuentas. Se anota en cada renovación y entrada. La pantalla enseña todas las cuentas de cada
aparato, la más reciente primero.

## Cómo se ve en Accesos

Pantalla **«Dispositivos»** (`/dashboard/dispositivos`; en esta primera versión **solo el administrador global**, SUPER ADMIN y
DESARROLLADOR, como todo el panel `/dashboard`; el ADMINISTRADOR de sucursal, con solo los de su sucursal, queda para después),
una pestaña por aplicación (Reparto y CRM siempre; las demás cuando tengan aparatos) (`Reparto`, `CRM`, …), con filtro por sucursal y
persona. Por aparato:

- **Cuentas** (TODAS las que han entrado en ese aparato, con su nombre y cuándo), **sucursal**, **aplicación y versión**, **plataforma**, **equipo**.
- **Visto por última vez**, última descarga, última subida (los dos últimos, si la app los informa).
- **Pendientes** y **rechazados**, y el **último error**.
- Una marca de color: *funciona* (visto hace poco y sin rechazados), *atascado* (pendientes o rechazados sin
  resolver / lleva mucho sin subir), *callado* (no se ve desde hace días).
- Acciones: **ponerle nombre**, **cerrar su sesión** (el aparato deja de renovar y sale), **bloquear** (no vuelve
  a entrar con ese `X-Aparato-Id` hasta que se desbloquee), **Ver actividad**.

## Para las aplicaciones que guardan una ficha local (CRM, Reparto…): leer de Accesos

Accesos es la fuente de la **identidad** del aparato; la aplicación guarda su ficha local con el **mismo `aparatoId`** para sus
claves foráneas y su trabajo, y lee de Accesos si existe, de quién es, versión, plataforma y si está bloqueado. Por la red
interna y con credencial de servicio (HMAC, como `/api/service/almacenes`; **sin** el `Bearer` antiguo):

```
GET /api/service/dispositivos[?app=crm][&sucursal=STG][&desde=<ISO>][&limite=500][&despues=<cursor>]
→ 200 { dispositivos: [{ aparatoId, userId, app, sucursal, plataforma, version, nombre,
                          estado: "activo" | "bloqueado", primeraVez, ultimaVez, actualizado,
                          cuentas: [{ userId, primeraVez, ultimaVez }] }],
        truncado: boolean, siguiente: string | null, hasta: ISO }
```

- **La aplicación sale de QUIÉN LLAMA**, no de `?app=`: la credencial de servicio lleva en sus `scopes` una entrada
  `dispositivos:<clientId>` por aplicación (`dispositivos:crm-apk`). Sin ese scope, 403 `sin_permiso_de_dispositivos`; con `?app=` de otra
  aplicación, 403 `app_no_permitida` (no una lista vacía); el comodín `*` no cuenta. **El CRM nunca ve un aparato de Reparto.** La
  migración `20261029160000_dispositivos` pone `dispositivos:crm-apk` a la credencial `crm`.
- `userId` es la **última** cuenta que entró; `cuentas` lista TODAS las que han entrado en ese aparato (la más reciente primero).
- `nombre`: el que le puso un administrador o, si no, el que informó el aparato. `actualizado`: última modificación de la ficha (para `desde=`).
- **`truncado: true` = hay más**: pedir la siguiente tanda con `despues=<siguiente>`. Una tanda truncada **no** se da por buena.
- Estados: solo `activo` y `bloqueado`. «Cerrar sesión» no es un estado (el aparato puede volver a entrar); bloquear sí.

**Aviso en vivo (Redis), UN CANAL POR APLICACIÓN**: `procovar:auth:dispositivos:<clientId>` (p. ej. `…:crm-apk`), sin prefijo de ioredis:

```
{"v":1,"tipo":"dispositivo-cambiado","app":"crm-apk","aparatoId":"<uuid>","estado":"activo"|"bloqueado",
 "motivo":"bloqueado"|"desbloqueado"|"sesion-cerrada"|"renombrado","tms":<ms>}
```

Puede perderse (Redis caído, la aplicación reiniciándose): **la fuente de verdad es la lista**; consultarla al arrancar y al reconectar con
`desde=<último "hasta" visto>`. (El Redis es compartido y sin ACL: el canal separa, no protege; el mensaje solo lleva ids.)

**Importar lo que la aplicación ya tenía** (aparatos anteriores a este registro): `POST /api/service/dispositivos`
`{ dispositivos: [{ aparatoId, userId, plataforma?, nombre?, version?, sucursal?, primeraVez?, ultimaVez? }] }` (máx. 100),
idempotente y sin pisar (`creado` | `ya_existia` | `persona_inexistente` | `invalido`); la aplicación es la de la credencial.

**Gestionar SUS aparatos desde la propia aplicación** (el CRM conserva sus pantallas de aparatos; los datos viven en Accesos). Mismo
alcance por credencial (`dispositivos:<clientId>`); un aparato de OTRA aplicación da 404 (no se cuenta qué aparatos hay):

```
POST /api/service/dispositivos/{aparatoId}/bloquear      cierra su sesión Y no vuelve a entrar con ese X-Aparato-Id
POST /api/service/dispositivos/{aparatoId}/desbloquear   le deja volver
POST /api/service/dispositivos/{aparatoId}/nombre        { "nombre": "Samsung de Palma" | null }   (1–80 car.; vacío o null = quitarlo)
→ 200 { ok: true, estado: "activo" | "bloqueado" }   · 400 · 403 · 404
```

Hace EXACTAMENTE lo que haría un administrador en el panel (cierra la cadena de refresh, queda en la auditoría con el servicio que lo pidió
y avisa por el canal de su aplicación con motivo `bloqueado` / `desbloqueado` / `renombrado`).

**UUID v7 para los nuevos; un id anterior solo si ya existe.** Un `X-Aparato-Id` que no sea v7 y no esté ya registrado no crea nada. Uno
que YA existe (importado con su id de antes) se sigue aceptando para actualizar su versión y su última vez, y para el bloqueo.

## Qué guarda Accesos (para que quede dicho)

Tres tablas. `dispositivo`: `aparatoId` (único), plataforma, equipo, nombre, última IP, primera y última vez visto. `dispositivo_app`: el aparato
en cada aplicación (`clientId`), con la última cuenta, sucursal, versión, el estado informado (`ultimaDescarga`, `ultimaSubida`,
`pendientes`, `rechazados`, `ultimoError`) y `bloqueadoAt`/`bloqueadoPor`. `dispositivo_persona`: cada cuenta que entró en cada aplicación. **No guarda** el contenido del trabajo, ni tokens, ni
datos de clientes. La IP y el `User-Agent` ya se guardan hoy en la sesión.

## Lo que NO hay que hacer

- No mandar tokens, contraseñas, nombres de clientes ni datos de negocio en las cabeceras ni en `ultimoError`.
- No usar el `aparatoId` como credencial: identifica, no autentica.
- No reintentar en bucle ni convertir un fallo del latido en un fallo de la aplicación.
- No generar un `X-Aparato-Id` nuevo en cada arranque: tiene que sobrevivir a reinicios y actualizaciones.

## Orden de puesta en producción

1. **Accesos** (migración aditiva `dispositivo` + `client_app.dispositivosUrl` + el scope del CRM; el reconocimiento de las cabeceras en
   `/refresh` y `/token`; `POST /api/dispositivos/estado`; `/api/service/dispositivos`; la pantalla). Es el login de todo: **no se
   despliega sin orden de Jose**. Rollback: la migración es solo aditiva (tabla y columna nuevas); basta volver a la imagen anterior.
2. **Reparto** (versión nueva de la APK y el escritorio: `X-Aparato-Id`, estado y su pantalla de actividad).
3. **CRM**: cuando Amado quiera. Hasta que Accesos esté desplegado, mandar las cabeceras no hace nada (se ignoran).
   Después, los pasos 1 y 2 de arriba; el 3 es opcional.

Preguntas o cambios del contrato: a Jose (Accesos y Reparto son suyos; el CRM lo escribe Amado).
