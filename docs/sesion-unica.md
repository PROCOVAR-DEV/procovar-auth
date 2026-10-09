# Sesión única: cuando Accesos cierra o cambia algo, las demás aplicaciones se enteran

Para quien programe una aplicación de Procovar (PEDIDO, Analitics, Rutas, Delivery, AFT, Notify, CRM…).

La idea de Jose: *«si inicio en una aplicación estoy logueado en las otras, y si cierro sesión o me
quitan un permiso en Accesos eso debe afectar a todas. Nada de polling: para eso tenemos SSE y
Sentinel; un reguero de peticiones no.»*

Por eso **Accesos empuja** y las aplicaciones **escuchan**. Nadie le pregunta a Accesos «¿sigue
valiendo esta sesión?» en cada petición.

---

## Estado de adhesión (08/10/2026)

El aviso lo publica Accesos para todas, escuche quien escuche: a quien no está suscrito no le
afecta en nada. Esta tabla dice quién ya lo escucha y por dónde seguir, en el orden recomendado.

| Aplicación | Estado | Cómo entra hoy | Cómo se engancharía y qué ya tiene |
|---|---|---|---|
| **Reparto (web)** | **ADHERIDA** | Accesos | Escucha el canal y cierra la web por SSE. |
| **Rutas** | PENDIENTE (1.ª) | Accesos: `/api/auth/login` → `/api/auth/callback` (canje del código), cookie propia | Go. Ya tiene un bus Redis (`rutas/api/internal/events`, go-redis) y un SSE (`/api/events`, `internal/api/events.go`). El suscriptor sería casi el mismo que el de Reparto: un segundo `Subscribe` al canal `procovar:auth:eventos`, una tabla en memoria de marcas y la comprobación en el middleware de sesión. |
| **Notify** | PENDIENTE (2.ª) | Accesos: `/admin/auth/sso/login` → `/callback`, cookie propia (`internal/http/sso_handlers.go`, mismo flujo que Rutas) | Go. Ya usa Redis en `cmd/api` y `cmd/worker`; faltan el suscriptor y la comprobación en el middleware que lee la cookie SSO. |
| **Delivery (el viejo, Next)** | PENDIENTE (3.ª) | Accesos: `/api/auth/entrar` → `/api/auth/callback`; luego emite su token de siempre en la cookie `token` | Ya tiene Redis (`src/lib/redis.ts`) y un SSE (`/api/eventos`). Hace falta un suscriptor (ioredis) arrancado una vez por proceso y comprobar la marca en `getUserFromRequest`, que es la cerradura por la que pasan sus endpoints. |
| **AFT** | PENDIENTE (4.ª) | Accesos por exchange: `backend/src/auth-sso.js`, JWT propio en cookie de 12 h | Node. No tiene Redis aún: añadir un cliente ioredis con Sentinel (ver ejemplo Node) y comprobar la marca donde verifica el JWT. |
| **PEDIDO** | PENDIENTE: primero vincular con Accesos | Login propio (`api/src/routes/auth.ts`). Con Accesos sólo habla de máquina a máquina (`/api/service/members`, trae vendedores) | Mientras la gente entre con la contraseña de PEDIDO, no hay sesión de Accesos que cerrar. Primero hay que hacer que entre por Accesos; luego, el ejemplo Node. |
| **Analitics** | PENDIENTE: primero vincular con Accesos | Login propio; no hay rastro de Accesos en el código | Igual que PEDIDO. |
| **CCSA / Parranda** | PENDIENTE: primero vincular con Accesos | Login propio (Flask + JWT) | Igual que PEDIDO. |
| **CRM** | PENDIENTE: primero vincular con Accesos | El código ya trae un cliente de Accesos (`api/internal/plataforma/accesos`, `AutenticacionConAccesos` para la cookie web), y la app móvil conserva su cadena JWT | Confirmar que la entrada web por Accesos está en producción; después, el ejemplo Go. Los clientes nativos usan la regla `todo` (ver más abajo). |

Esta tabla se actualiza a medida que cada aplicación se incorpora: **cambia el estado aquí cuando
la tuya empiece a escuchar.**

---

## El contrato (fijo)

### 1. El canal

Pub/sub de Redis, en el **mismo Redis con Sentinel** de siempre:

```
procovar:auth:eventos
```

Literal exacto. **Los canales no llevan el `keyPrefix`** de ioredis (ni de nadie): suscríbete con el
nombre tal cual.

### 2. El mensaje

JSON UTF-8, uno por publicación:

```json
{"v":1,"tipo":"sesion-cerrada","userIds":["0192f3e4-7b1a-7c2d-9e55-3a1f0c6d8b21"],"tms":1790000000123,"motivo":"logout","alcance":"web"}
```

| Campo | Valores | Significa |
|---|---|---|
| `v` | `1` | Versión del contrato. Si no es `1`, ignora el mensaje y regístralo. |
| `tipo` | `"sesion-cerrada"` · `"permisos-cambiados"` | Ver abajo. |
| `userIds` | hasta **500** ids | Las personas afectadas (ids de Accesos). Una publicación grande llega partida en varios mensajes con el mismo `tms`. |
| `tms` | entero | Unix en **MILISEGUNDOS** (no segundos). |
| `motivo` | `logout` · `revocada` · `baja` · `rol` · `llaves` · `admin` · `membresia` | Para registro y para entender qué pasó. |
| `alcance` | `"web"` · `"todo"` | A qué sesiones afecta (ver la regla). |

- **`sesion-cerrada`**: la sesión se cerró. La persona tiene que entrar de nuevo.
- **`permisos-cambiados`**: sus roles, llaves o sucursales cambiaron. Lo que tu aplicación sabe de
  ella ya no vale; al volver a entrar por Accesos se recalculan roles y `entradas`.

Para tu aplicación la **regla es la misma** en los dos tipos: lo emitido antes del `tms` ya no vale.

### 3. `alcance`: web o todo

| `motivo` | `alcance` | Qué cierra |
|---|---|---|
| `logout` | **`web`** | Sólo las sesiones **web** (cookie) de la persona. **No** corta los dispositivos nativos (APK, escritorio), que tienen su propio login. |
| `revocada` (revocación explícita), `baja`, `rol`, `llaves`, `admin`, `membresia` y borrado | **`todo`** | La web **y** los dispositivos. |

### 4. La marca de recuperación

Un mensaje pub/sub no se guarda: quien no está escuchando en ese instante lo pierde. Por eso,
**antes de publicar**, Accesos escribe una marca por persona en el mismo Redis:

```
SET procovar:auth:invalida:<alcance>:<userId>  <tms>  EX 691200
```

- **DB 6** (`REDIS_DB_SESSIONS`), y **clave literal, sin ningún prefijo**.
- Dos claves posibles por persona: `procovar:auth:invalida:web:<userId>` y
  `procovar:auth:invalida:todo:<userId>`. Un evento `web` escribe **sólo** la `web`; un evento `todo`
  escribe la `todo` (la web la mira también, ver la regla).
- El valor es el `tms` en ms. Un evento nuevo de la misma persona **sube** la marca, pero **nunca la
  baja**: Accesos la escribe con un script Lua (`GET`; `SET … EX` sólo si no existe o la nueva es mayor),
  así que un aviso tardío o reintentado no puede hacerla retroceder y resucitar sesiones.
- TTL de 691200 s = **8 días**: un poco más que la cookie más larga de una aplicación. Pasado ese
  tiempo ninguna sesión emitida antes puede seguir viva, así que la marca ya no hace falta.

Una aplicación que arranca, se reinicia o reconecta reconstruye su tabla con
`SCAN procovar:auth:invalida:*` en la DB 6. Es lectura **una vez al conectar**, no un bucle.

### 5. La regla (lo único que tiene que hacer tu aplicación)

> Compara cuándo se **emitió** la sesión con la marca de la persona.
>
> - **Sesión web** (cookie): inválida si `max(web, todo) >= emitidaEn`.
> - **Cliente nativo con bearer** (APK, escritorio): inválido sólo si `todo >= emitidaEn`.
>
> Si es inválida: se borra la cookie / se rechaza el token, y la persona vuelve a entrar por Accesos.

Dos cuidados con las unidades:

1. `tms` y las marcas están en **milisegundos**. Un `iat` de JWT está en **segundos**: compara
   `iat * 1000`, o mejor guarda en tu cookie la hora de emisión en ms.
   **Token de acceso de la APK:** además de `iat` (s) lleva el claim **`iatms`** (ms, entero), la
   hora exacta de emisión. El consumidor **prefiere `iatms` y, si falta (token viejo), usa
   `iat * 1000`**. Con sólo `iat`, un token pedido 250 ms después del evento se rechazaba en ~el 75 %
   de los casos —`iat * 1000` queda por debajo de la marca—, y la APK renueva justo al recibir el aviso.
2. «Emitida antes» incluye el mismo instante (`>=`). Con segundos de resolución, quien vuelve a entrar
   en el mismo segundo que cerró puede ver un rebote de un segundo; con ms no.

Volver a entrar es automático si su sesión de Accesos sigue viva (el caso típico de
`permisos-cambiados`); allí se recalculan roles y `entradas`. Si lo que se cerró fue la sesión de
Accesos, la persona verá la pantalla de acceso.

---

## De punta a punta

```
 Persona        Accesos (auth)                     Redis (Sentinel)                 Aplicación X
    |                |                                   |                               |
    |-- cerrar sesión ->                                  |                               |
    |                |-- (1) la base: borra/revoca       |                               |
    |                |       la sesión                   |                               |
    |                |-- (2) SET invalida:web:<id> tms ->|  (DB 6, EX 691200)           |
    |                |-- (3) PUBLISH procovar:auth:eventos {…"sesion-cerrada","alcance":"web"}
    |                |                                   |-- mensaje ------------------>|
    |<- redirige ----|                                   |        (4) anota max(tms), y |
    |                |                                   |        cierra SU sesión web: |
    |                |                                   |        SSE "sesion-cerrada" al navegador
    |                |                                   |                               |
    |-- siguiente petición a X con una cookie vieja ----------------------------------->|
    |                |                                   |        (5) emitidaEn <= tms: |
    |<-------------- 401 / redirige a Accesos ------------------------------------------|
    |-- entra de nuevo por Accesos (silencioso si su sesión de Accesos sigue viva) ---->|

 Si X estaba caída o reiniciándose en (3):
    X arranca -> SUBSCRIBE -> SCAN procovar:auth:invalida:* (DB 6) -> reconstruye la tabla -> sigue igual.
```

Qué publica Accesos y cuándo (siempre **después** de que la base haya tenido éxito, y sin esperar a
Redis más de ~1 s):

| Dónde ocurre en Accesos | Evento | `motivo` / `alcance` |
|---|---|---|
| Cerrar sesión: botón del navegador (`authClient.signOut` → `/api/auth/sign-out`), `auth.api.signOut` (`/api/auth/logout-fanout`, acción de `(base)/logout`, `auth.server`) | `sesion-cerrada` | `logout` / `web` |
| Cerrar sesión desde el aparato (`POST /api/auth/logout`, APK) | **nada**: se cierra su familia de refresh y la sesión del aparato, sin tocar a los demás | — |
| `revoke-session` de better-auth (UNA sesión): según CUÁL sea. Navegador → `logout` / `web`; sesión de un aparato (`clientId` `delivery-apk`), token de otra persona o inexistente → **nada** | `sesion-cerrada` | `logout` / `web` (o nada) |
| «Cerrar las demás sesiones» / `revoke-sessions` / `revoke-other-sessions` de better-auth; cambiar la contraseña revocando las otras (el perfil ahora lo pide siempre); **restablecer la contraseña** por el enlace del correo (cierra todas) | `sesion-cerrada` | `revocada` / `todo` |
| `POST /api/auth/revoke-session` (servicio; `userId`/`sessionId` de 1 a 128 caracteres y la persona tiene que existir) y panel: revocar una sesión, revocar todas, poner otra contraseña | `sesion-cerrada` | `revocada` / `todo` |
| Un refresh de la APK reutilizado (robo): se cierra la cuenta entera | `sesion-cerrada` | `revocada` / `todo` |
| Borrar a una persona | `sesion-cerrada` | `baja` / `todo` |
| **Quitar** el mando (`isSystemAdmin`) | `permisos-cambiados` | `admin` / `todo` |
| Cambiar el rol por defecto de una persona **si pierde llaves** o deja de ser Super Admin; **quitar** roles de un miembro; **bajar** de rango a un miembro (`owner`/`admin`/`staff`/`agent`) o ceder la propiedad (sólo avisa al que la cede) | `permisos-cambiados` | `rol` / `todo` |
| Cambiar los permisos de un rol o restablecerlos **si el rol PIERDE alguna llave**; renombrarlo | `permisos-cambiados` a **todas** las personas con ese rol (por defecto o por membresía) | `llaves` (o `rol` si sólo cambia el nombre) / `todo` |
| Borrar un rol | `permisos-cambiados` a quienes lo tenían por defecto | `rol` / `todo` |
| **Quitar** a alguien de una sucursal | `permisos-cambiados` | `membresia` / `todo` |
| Borrar una sucursal; **desactivarla** o **cambiar su código** (sólo si cambian de verdad: «Editar sucursal» manda siempre ambos campos y guardar sin tocarlos no avisa) | `permisos-cambiados` a todas las personas de la sucursal | `membresia` / `todo` |

**Regla (auditoría de seguridad 08/10/2026): sólo se publica `todo` cuando alguien PIERDE acceso.**
Dar acceso no publica nada, porque sólo se gana: el alta en una sucursal (`anadirPersona`,
`agregarMiembro`, `POST /api/organizations/**`), aceptar una invitación, un rol o una llave que se
**añaden**, dar el mando, reactivar una sucursal. Si no, quien puede dar de alta podría echar de todas
las aplicaciones a cualquiera «dándole de alta». Quien se entera tarde de un permiso nuevo lo hará en
el siguiente refresco natural de su sesión. La decisión está en `src/lib/pierde-acceso.ts`.

Los endpoints del plugin `organization` de better-auth (`/api/auth/organization/*`: `remove-member`,
`update-member-role`, `leave`, `accept-invitation`, `delete`, `create`…) cambian membresías sin pasar por
estos avisos, así que `src/app/api/auth/[...all]/route.ts` los corta con 404 salvo `set-active` (lo
único que usa la interfaz) y las lecturas (GET); y `allowUserToCreateOrganization` está en `false`. Las
sucursales las crea un Super Admin por la acción `crearSucursal`.

Lo que **no** publica (a propósito): cambios de nombre, teléfono o correo verificado; la siembra de
permisos nuevos al arrancar (`syncRbac`, sólo añade); los scripts de `scripts/` (corren fuera del
servidor). Ninguna pantalla de Accesos marca hoy una baja con `activo=false` (sólo lo hace un script
de importación); cuando exista, publicará `sesion-cerrada` / `baja`.

Código: `src/lib/eventos-de-sesion.ts` (publicar), `src/lib/hooks-de-sesion.ts` (better-auth),
`src/lib/pierde-acceso.ts` (cuándo avisar), `src/lib/rutas-de-better-auth.ts` (lo que se corta).
Pruebas: `src/lib/__tests__/eventos-de-sesion.test.ts`, `marca-solo-sube.test.ts` (Redis real, con
`REDIS_DE_PRUEBA=redis://…`), `hooks-de-sesion.test.ts`, `restablecer-contrasena.test.ts`,
`organizacion-cerrada.test.ts`, `pierde-acceso.test.ts`, `src/app/api/__tests__/alcance-por-sucursal.test.ts`,
`src/app/api/__tests__/avisos-a-las-aplicaciones.test.ts` y
`src/app/(user)/dashboard/__tests__/avisos-a-las-aplicaciones.test.ts`.

---

## Si Redis cae

**Tu aplicación sigue funcionando.** Es la regla de oro: la sesión única es una mejora de seguridad, no
una dependencia de arranque.

- **Sin Redis al arrancar**: arranca igual, sin tabla de marcas. Reintenta conectar con espera
  creciente (ioredis y go-redis lo hacen solos) y registra un aviso por intento, no uno por petición.
- **Redis cae con la aplicación en marcha**: sigue sirviendo con la tabla que tiene en memoria. No
  bloquees ninguna petición esperando a Redis.
- **Al reconectar**: vuelve a suscribirte (las librerías lo hacen) y **recarga las marcas con
  `SCAN`**, porque lo publicado mientras estabas desconectado se perdió. Eso es todo.
- **Si Redis estaba caído cuando Accesos publicó**, ese aviso puede perderse (un fallo de Redis nunca
  rompe la acción de quien cerró sesión). Para `baja` y `revocada` Accesos lo deja en el registro en
  nivel `error` con los ids internos de las personas y lo reintenta en segundo plano (backoff de 2, 5,
  15 y 30 s y luego cada 60 s, hasta 10 minutos; con el mismo `tms`, sin retrasar su respuesta: ver la
  nota del 09/10/2026 al final); el resto de motivos sólo deja un aviso (`warn`) sin ids. Si Redis no
  vuelve en esa ventana (o Accesos se reinicia con avisos pendientes), esa persona conserva su sesión
  en tu aplicación hasta que la cookie caduque. Es el límite conocido del diseño, y no se arregla con
  polling.

## Qué NO hacer

- **No le preguntes a Accesos en cada petición** «¿esta sesión sigue vigente?». Ni con
  `verify-session`, ni cada N segundos, ni «por si acaso». El aviso llega solo.
- **No hagas polling de Redis** (`GET` de la marca en cada petición). Se lee **una vez al conectar**
  con `SCAN` y después se mantiene la tabla en memoria con los mensajes.
- **No uses `KEYS procovar:auth:invalida:*`**: bloquea Redis. Es `SCAN`.
- **No añadas el `keyPrefix`** de tu cliente al canal ni a estas claves: son literales, y es lo que
  rompe más veces la integración.
- **No suscribas la misma conexión que usas para comandos**: en Redis, una conexión suscrita sólo
  puede escuchar. Usa una conexión aparte para el `SUBSCRIBE`.
- **No trates un mensaje perdido como un error de tu aplicación**: se recupera con la marca.
- **No cierres sesiones nativas con un evento `web`**: el `logout` de una persona en el navegador no
  tiene por qué cerrar su APK. Respeta el `alcance`.

---

## Ejemplos mínimos de suscriptor

Lo importante en los dos: (1) **suscribirte primero y después hacer el `SCAN`**, para no dejar
huecos; (2) repetir `SCAN` en cada reconexión; (3) conexión de suscripción separada.

### Node (ioredis con Sentinel)

```js
import Redis from 'ioredis';

const CANAL = 'procovar:auth:eventos';
const base = {
  sentinels: process.env.REDIS_SENTINELS.split(',').map((s) => {
    const [host, port] = s.trim().split(':');
    return { host, port: Number(port || 26379) };
  }),
  name: process.env.REDIS_MASTER_NAME || 'master',
  password: process.env.REDIS_PASSWORD,
  sentinelPassword: process.env.REDIS_PASSWORD,
  // OJO: sin keyPrefix. El canal y las marcas son literales.
};

// userId -> { web: ms, todo: ms }
const marcas = new Map();
function anotar(userId, alcance, tms) {
  const m = marcas.get(userId) ?? { web: 0, todo: 0 };
  m[alcance] = Math.max(m[alcance], tms); // el mayor gana
  marcas.set(userId, m);
}

const sub = new Redis(base);              // sólo para suscribirse
const datos = new Redis({ ...base, db: 6 }); // marcas: DB de sesiones

async function recargar() {
  let cursor = '0';
  do {
    const [sig, claves] = await datos.scan(cursor, 'MATCH', 'procovar:auth:invalida:*', 'COUNT', 500);
    cursor = sig;
    if (!claves.length) continue;
    const valores = await datos.mget(claves);
    claves.forEach((clave, i) => {
      const m = /^procovar:auth:invalida:(web|todo):(.+)$/.exec(clave);
      if (m && valores[i]) anotar(m[2], m[1], Number(valores[i]));
    });
  } while (cursor !== '0');
}

sub.on('message', (_canal, texto) => {
  let e;
  try { e = JSON.parse(texto); } catch { return; }
  if (e.v !== 1 || !Array.isArray(e.userIds)) return;
  for (const id of e.userIds) anotar(id, e.alcance === 'web' ? 'web' : 'todo', e.tms);
  // Aquí también: avisar al navegador por SSE para que cierre la web al instante.
});

// 'ready' salta al conectar y en CADA reconexión: ahí se re-suscribe y se recarga.
sub.on('ready', async () => {
  try { await sub.subscribe(CANAL); await recargar(); }
  catch (err) { console.warn('sesión única: no se pudo sincronizar', err.message); }
});
sub.on('error', () => {}); // la aplicación sigue sin Redis; ioredis reintenta solo

// La regla. `emitidaEnMs`: cuándo se emitió la cookie o el token.
export function sesionValida({ userId, emitidaEnMs, nativo = false }) {
  const m = marcas.get(userId);
  if (!m) return true;
  const corte = nativo ? m.todo : Math.max(m.web, m.todo);
  return emitidaEnMs > corte;
}
```

### Go (go-redis v9 con Sentinel)

```go
package sesionunica

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const canal = "procovar:auth:eventos"

type evento struct {
	V       int      `json:"v"`
	Tipo    string   `json:"tipo"`
	UserIDs []string `json:"userIds"`
	Tms     int64    `json:"tms"` // milisegundos
	Motivo  string   `json:"motivo"`
	Alcance string   `json:"alcance"`
}

type marca struct{ web, todo int64 }

type Tabla struct {
	mu sync.RWMutex
	m  map[string]marca
}

func (t *Tabla) anotar(id, alcance string, tms int64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	x := t.m[id]
	if alcance == "web" && tms > x.web {
		x.web = tms
	} else if alcance != "web" && tms > x.todo {
		x.todo = tms
	}
	t.m[id] = x
}

// Valida aplica la regla. emitidaMs: cuándo se emitió la cookie o el token.
func (t *Tabla) Valida(id string, emitidaMs int64, nativo bool) bool {
	t.mu.RLock()
	x := t.m[id]
	t.mu.RUnlock()
	corte := x.todo
	if !nativo && x.web > corte {
		corte = x.web
	}
	return emitidaMs > corte
}

var reClave = regexp.MustCompile(`^procovar:auth:invalida:(web|todo):(.+)$`)

// Escuchar bloquea hasta que ctx se cancele. Lanzar con `go`.
func Escuchar(ctx context.Context, t *Tabla, opts *redis.FailoverOptions) {
	// opts.DB = 6 para leer las marcas. SIN prefijo de claves: go-redis no lo añade.
	rdb := redis.NewFailoverClient(opts)
	defer rdb.Close()

	sub := rdb.Subscribe(ctx, canal) // conexión propia para la suscripción
	defer sub.Close()

	for ctx.Err() == nil {
		msg, err := sub.Receive(ctx)
		if err != nil {
			slog.Warn("sesión única: Redis no contesta", "error", err)
			time.Sleep(time.Second) // go-redis reconecta y re-suscribe en la siguiente llamada
			continue
		}
		switch m := msg.(type) {
		case *redis.Subscription:
			// Llega al suscribirse y en cada reconexión: se recargan las marcas.
			if m.Kind == "subscribe" {
				recargar(ctx, rdb, t)
			}
		case *redis.Message:
			var e evento
			if json.Unmarshal([]byte(m.Payload), &e) != nil || e.V != 1 {
				continue
			}
			for _, id := range e.UserIDs {
				t.anotar(id, e.Alcance, e.Tms)
			}
		}
	}
}

func recargar(ctx context.Context, rdb *redis.Client, t *Tabla) {
	iter := rdb.Scan(ctx, 0, "procovar:auth:invalida:*", 500).Iterator()
	for iter.Next(ctx) {
		m := reClave.FindStringSubmatch(iter.Val())
		if m == nil {
			continue
		}
		v, err := rdb.Get(ctx, iter.Val()).Result()
		if err != nil {
			continue
		}
		if tms, err := strconv.ParseInt(v, 10, 64); err == nil {
			t.anotar(m[2], m[1], tms)
		}
	}
}
```

(Ejemplos mínimos: ajusta nombres y registro a tu aplicación. En Go, `redis.NewFailoverClient` devuelve un
`*redis.Client`; si ya tienes uno configurado con Sentinel, reutilízalo.)

---

## Nota (08/10/2026): «Dispositivos y sesiones» en Mi cuenta y qué avisa cada cierre

El alcance lo decide la CLASE de sesión, no el hardware: un navegador (aunque sea el de un
teléfono) es web; la APK y el escritorio de Reparto son dispositivos con su propio login.

| Acción en Mi cuenta | Camino | Aviso |
|---|---|---|
| Cerrar sesión / «Cerrar esta sesión» de la fila actual | `sign-out` | `logout` → alcance `web` |
| «Cerrar esta sesión» de OTRO navegador | `revoke-session` | `logout` → alcance `web` (conservador: los otros navegadores pasan por Accesos y vuelven solos mientras su sesión de Accesos siga viva) |
| «Cerrar este dispositivo» (APK / escritorio) | `cerrarFamilia` (su familia de refresh y su sesión) | ninguno: se cierra cuando el aparato vuelva a conectarse o, como mucho, en 15 minutos |
| «Cerrar las demás sesiones» | `revoke-other-sessions` | `revocada` → alcance `todo` |
| «Cerrar en todos los dispositivos» | `revoke-sessions` | `revocada` → alcance `todo` |

`/revoke-session` ya NO publica `todo` siempre: `hooks-de-sesion.ts` mira qué sesión se cierra
(token de otra persona o inexistente: nada; sesión con `clientId` `delivery-apk`: nada; web: `web`).

---

## Nota (09/10/2026): endurecimiento tras las auditorías

Seis cambios en Accesos que afectan a quien consume `verify-session`, `verify`, `exchange` o el aviso.

### 1. `verify-session` y `verify` ya miran `activo`

Una persona dada de baja (`activo = false`) con la sesión ya abierta seguía valiendo para las
aplicaciones que sólo llaman a `verify-session`: better-auth no mira esa columna.

- `POST /api/auth/verify-session` → **401 `{ "error": "invalid_session" }`** si `user.activo === false`
  (la misma forma que una sesión inválida; los demás 401, `invalid_session` y `session_revoked`, no cambian).
- `POST /api/auth/verify` (JWT) → **401 `{ "valid": false, "error": "user_inactive" }`** si el token nombra
  (claim `sub` o `userId`) a una persona de baja. Un `sub` que no es de nadie (p. ej. el clientId de un
  JWT de plataforma) no encuentra fila y sigue valiendo. Si la base no contesta al comprobarlo:
  **503 `{ "valid": false, "error": "service_unavailable" }`** (cerrado, nunca `valid: true`).

### 2. Redis caído: la firma de servicio falla CERRADA y RÁPIDO

El anti-replay del nonce (`X-Nonce`, `SET NX` en Redis) necesita Redis. Antes, con Redis caído,
cualquier endpoint con firma de servicio (`verify-session`, `exchange`, `sign`…) daba **500
`internal_error` tras ~4,4 s**. Ahora:

- **503 `{ "error": "service_unavailable" }` en menos de 1 s** (la comprobación espera a Redis como
  mucho `NONCE_ESPERA_MAX_MS` = 800 ms; el tiempo de espera de los demás usos de Redis no cambia).
- No deja pasar la petición (sin poder saber si el nonce es un replay, se rechaza) y no se traga el
  error: queda en el registro (`[service-auth] Redis no responde…`). Un nonce repetido sigue siendo
  401 `replay`.
- Tu cliente debe tratar el 503 como «reintenta en unos segundos», no como sesión inválida.

### 3. Reintento durable del aviso `baja` / `revocada`

Antes, si Redis tardaba más de ~2 s en volver, el aviso grave se perdía (un solo reintento). Ahora
(`src/lib/eventos-de-sesion.ts`), sólo para `baja` y `revocada`:

- Cola **en memoria** acotada a **1000** avisos; el que no cabe se registra como perdido (`error`, con ids).
- Reintentos con espera de **2, 5, 15 y 30 s y luego cada 60 s, hasta 10 minutos** desde el primer fallo;
  después se da por vencido con `logger.error` y los ids internos. Los intermedios son `warn` sin ids.
- Sin duplicados por (tipo, alcance, motivo, personas): si el mismo aviso se repite mientras espera, no
  se encola dos veces y sale con el `tms` más reciente. Siempre se publica con el `tms` **original**
  (la marca sólo sube, así que publicarlo tarde no resucita nada) y **una sola vez**.
- Nunca bloquea ni retrasa la respuesta del cierre/baja/revocación: es un temporizador aparte con
  `unref()` (no impide apagar el proceso).
- Es memoria: un reinicio de Accesos con avisos pendientes los pierde (queda el `error` con los ids).

### 4. `exchange` manda también `codigo`

`POST /api/auth/exchange` → `memberships[].organization` lleva ahora **`codigo`** (`organization.codigo`,
p. ej. `CAM`, `HAB`, `PLS`; `null` si la sucursal no tiene) **además** de `id`, `name`, `slug` y `logo`
(que no cambian). El slug no siempre es el código en minúsculas (`PLS` tiene slug `palma-soriano`):
quien necesite el código debe leer `codigo`, no deducirlo del slug.

### 5. Índice por `userId` en `session` y purga de lo caducado

- `session` tiene `@@index([userId])` (migración `20261009130000_indice_session_userid`,
  `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId")`).
- `purgarCaducadas()` (`src/lib/purga-caducadas.ts`) borra `session` y `refresh_token` con
  `expiresAt < ahora - 30 días`, en lotes de 1000 (hasta 20 pasadas por tabla y ejecución). Una fila
  de `refresh_token` ya gastada se conserva para reconocer la reutilización (robo) mientras el token
  pudiera estar vivo; con `expiresAt` 30 días en el pasado ya no sirve a nadie. Una fila usada o
  revocada pero NO caducada nunca se toca. Corre al arrancar (sin bloquear el arranque ni tumbarlo
  si falla; `instrumentation.ts`) y cada 24 h.

### 6. Borrados

`src/app/api/events/route.ts` y `src/hooks/use-org-events.ts` (huérfanos de qb, con un *bearer* de
desarrollo por defecto) y la variable `QB_BACKEND_URL` de `docker-compose.yml`.
