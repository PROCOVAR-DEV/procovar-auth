# Avisos por aplicación: cómo funciona hoy y qué falta

Revisión pedida por Jose el 08/10/2026: «que las aplicaciones tengan su canal para que
sepan de cada lado lo que se tiene que notificar, de cada lugar a cada usuario».

**Qué se leyó:** el código de `procovar/notify` (Go + React), el cliente de Accesos
(`src/lib/notifications.ts`, `src/lib/notify/*`, `src/app/api/notifications/*`), el canal de
Reparto (`delivery-logistica/api/internal/api/canal_notify.go`) y las notas de Obsidian.
**Qué NO se comprobó:** nada en el servidor (sin ssh, por la regla de la casa). Lo que diga de
producción sale de comentarios del código y de las notas, con su fecha.

---

## 0. En ocho líneas

1. Notify **sí** tiene el molde de «una aplicación = un canal»: cada *Application* tiene su
   clave de API, sus tipos de aviso, sus plantillas, su SMTP, sus cuotas y su auditoría.
2. Pero ese molde **no está usado así**: en producción hay (a 26/09/2026) tres aplicaciones,
   *Demo*, *Procovar* y *Servidor*, y siete tipos en total. No hay una por PEDIDO, Analitics,
   Rutas, Delivery o AFT.
3. Hoy **solo emiten dos**: Accesos (cinco correos de cuenta) y Reparto (un correo de
   vigilancia a una dirección fija). PEDIDO, Analitics, Rutas, Delivery, AFT, Asignación, el CRM
   y Parranda **no tienen ni una línea** que hable con Notify.
4. Nadie emite avisos de **pantalla** (`IN_APP`) en Procovar. La campana y su panel funcionan,
   pero hoy mostrarán «No tienes avisos» hasta que una aplicación emita.
5. **No existe** el registro de «qué avisos tiene cada aplicación y a quién va»: los tipos los da
   de alta a mano un administrador en la pantalla de Notify, sin dueño, sin descripción para la
   persona y sin destinatarios previstos.
6. **No existe** que una persona silencie por aplicación o por tipo. Las preferencias de Notify
   son solo por canal (correo, push, SMS, pantalla) y por «aplicación» de Notify; **Accesos nunca
   las llama**.
7. La pantalla de preferencias de Accesos (`/profile#configurar-perfil`) **es de adorno**: sus
   interruptores se guardan en el navegador (`localStorage`) y no llegan a Notify. Hablan de
   reservas, facturas y marketing, que son restos de qb.
8. Lo mínimo para llegar a lo que pide Jose (sección 4): sellar la aplicación de origen en
   claves, tipos y avisos; un catálogo legible; preferencias por tipo con marca «obligatorio»;
   dos rutas nuevas en Accesos; y una pantalla de preferencias agrupada por aplicación.

---

## 1. Cómo funciona hoy un aviso, de punta a punta

### 1.1 Las piezas

```
  aplicación emisora           Notify api                 Notify worker             destino
  (Accesos, Reparto...)        avisos-api.procovar.cloud  (cola asynq + Redis)
  ───────────────────          ────────────────────────   ─────────────────         ────────
  POST /v1/notifications  ──►  1 valida firma HMAC
  { type, recipient,           2 resuelve el TIPO  ───┐
    recipientUserId,           3 plantilla + variables│
    payload, idempotencyKey }  4 ¿la persona silenció │
                                  este CANAL?         │
                               5 ¿está suprimida?     │
                               6 guarda en Postgres   │
                               7 encola          ─────┴──►  renderiza plantilla ──►  correo (SMTP)
                          ◄──  202 {id, status}             reintenta con backoff     push / SMS
                                                            guarda cada intento       o, en IN_APP,
                                                                                      la propia fila
                                                                                      ES la bandeja
```

- **Notify** son tres contenedores en Dokploy (`api`, `worker`, `web`), con Postgres y Redis
  compartidos (Redis: prefijo `notify`, bases 8 a 10). `docker-compose.procovar.yml`.
- **La pantalla de administrar** es `avisos.procovar.cloud`. No tiene login propio: entra quien
  Accesos diga, con la llave `avisos.entrar`. Con `avisos.manage` o administrador de sistema es
  `SUPER_ADMIN` de Notify; solo con `avisos.entrar` es `APP_ADMIN` (`notify/backend/internal/auth/admin.go`).
- **Esas llaves `avisos.*` las lleva solo DESARROLLADOR**, ni siquiera el Super Admin
  (`src/rbac/system-roles.ts`, `SOLO_DESARROLLADOR`). Es deliberado y es lo correcto para
  *administrar*: tocar tipos y plantillas sin saber deja a la gente sin avisos sin que salte
  ningún error (el envío sigue devolviendo 202).

### 1.2 Los conceptos de Notify

| Concepto | Qué es | Dónde está |
|---|---|---|
| **Application** | El «inquilino». Todo lo demás cuelga de ella (`application_id`) y una consulta de una aplicación no ve lo de otra. | tabla `applications` (nombre, slug, estado) |
| **API key** | Credencial de una aplicación. Firma HMAC con tres cabeceras `X-QBN-*`. Lleva *scopes*: `notifications:send` (emitir) y `notifications:read` (leer bandeja y preferencias). | `api_keys` |
| **Tipo de notificación** | «Un nombre + un canal + una plantilla + un destino de salida (SMTP o proveedor)». El nombre es único **dentro de la aplicación**. Es lo que el emisor manda en `type`. Si no existe: `404 notification_type_not_found`. | `channel_routes` |
| **Plantilla** | Texto con `{{variables}}`, por clave, idioma y versión. Declara variables obligatorias (JSON Schema): si falta una, el envío se rechaza. | `templates` |
| **Canal** | `EMAIL`, `PUSH`, `SMS`, `IN_APP`. Lo dicta la plantilla. | enum `channel` |
| **Notificación** | La solicitud concreta: tipo, canal, destinatario (`recipient` + `recipientUserId` opcional), `payload`, prioridad, estado (`SENT` = sin leer, `READ`…), `readAt`, `archivedAt`. | `notifications` |
| **Preferencias** | Un interruptor por canal y por persona **dentro de una aplicación**: correo sí, push sí, SMS no, pantalla sí. | `user_notification_preferences` |
| Otros | Cuotas, lista de supresión (rebotes), retención/PII, webhooks de estado, envíos recurrentes, auditoría. | migraciones 00002 a 00013 |

### 1.3 Quién emite hoy

| Emisor | Qué manda | Tipo (nombre en Notify) | Canal | A quién |
|---|---|---|---|---|
| **Accesos** (`src/lib/notifications.ts`) | verificación de correo, bienvenida, recuperar contraseña, contraseña cambiada, invitación a una organización | `email-verification`, `welcome-register`, `forgot-password`, `password-reset-success`, `invitation` | correo | a la propia persona (`recipient.email`, con su `recipientUserId`) |
| **Reparto** (`canal_notify.go`) | el vigía del canal con PEDIDO: atascos, rechazos, entradas mudas | `aviso-servidor` (el tipo de la aplicación *Servidor*, el único «probado de verdad») | correo | a **una dirección fija**, `QB_NOTIFY_DESTINO` |
| **El servidor (VPS)** | seguridad, copias, disco, vigilantes | por `procovar-avisar` | correo | a Jose y a Amado (una petición por destinatario; si falla, cae a SMTP directo). Notas del 07/09/2026: en esa fecha Notify aún no estaba desplegado; el 26/09 ya lo está. |
| PEDIDO, Analitics, Rutas, Delivery (viejo), AFT, Asignación, CRM, Parranda | nada | — | — | `grep` de `NOTIFY_URL`, `QB_NOTIFY`, `notify-api`, `avisos-api`, `X-QBN` en cada repo: sin resultados |

Los tipos de Accesos van **escritos en el código** y el tipo debe existir con ese nombre en
Notify, bajo la aplicación a la que pertenece la clave. Una clave de una aplicación con el
tipo de otra da un 404 que no menciona la aplicación (ya costó una vuelta en Reparto).

### 1.4 A quién llega

Lo decide **el emisor**, uno por uno:

- Correo: `recipient.email`. Notify acepta **un** destinatario por petición.
- Pantalla (`IN_APP`): basta `recipientUserId`. Ese id es **el id de la persona en Accesos**.
- No hay «avisar a todos los GESTOR de HOL». El emisor tendría que averiguar quiénes son. Para
  eso ya existe en Accesos `POST /api/service/members` (nombre, correo y rol de la gente de una
  sucursal, con service-auth), pero ningún emisor lo usa para avisar.

### 1.5 Dónde lo ve y lo configura cada persona

| Qué | Dónde | Estado |
|---|---|---|
| Ver los últimos avisos | **Campana de la cabecera → panel emergente** (5 por página, «Página X de Y», botón «Gestionar avisos»). Datos: `GET /api/notifications/panel`, que toma el id de la **sesión** y pide la bandeja `IN_APP` a Notify. | hecho hoy (08/10/2026) |
| Ver todos, leer, archivar | `/profile/notifications` y `/profile/notifications/[id]` (filtros sin leer / todos / archivados) | existe |
| Configurar qué quiero recibir | `NotificationsSection`, en `/profile#configurar-perfil`: correo, confirmaciones de reserva, facturas, avisos de servicio, marketing | **de adorno**: solo `localStorage` (`useProfileDataStore`); no llama a Notify |
| Preferencias reales (Notify) | `GET/PUT /v1/users/{userId}/preferences`: correo/push/SMS/pantalla | existe en Notify; **Accesos no la usa** |

Notas técnicas del panel:

- El panel pide a Notify las 100 más recientes (el máximo que admite su API) y las trocea en
  memoria, porque la API de bandeja solo pagina por cursor y **no devuelve el total**. Es el
  único modo de dar «página X de Y» sin tocar Notify. Más allá de 100 hay que ir a
  `/profile/notifications`.
- Si Notify no contesta, el panel dice «No se pudieron cargar los avisos» con un botón de
  reintentar; no dice «No tienes avisos», que sería mentir. La cabecera y el resto de la página
  no se tocan.
- El tiempo real (`/api/events`) lo sirve `QB_BACKEND_URL`, que es el backend de qb. Si en
  Procovar no está configurado, la ruta responde 500 y la campana se actualiza sola por sondeo,
  cada 60 s y al volver a la pestaña.
- `src/lib/notify/types.ts` (`NotifyType`, `notificationHref`) y el detalle de aviso conservan
  los tipos de qb (reservas, facturas, *holds*). Ninguno se emite en Procovar.

---

## 2. ¿Puede hoy una aplicación tener su propio canal y saber «de cada lado, a cada usuario»?

| Pregunta | Respuesta | Detalle |
|---|---|---|
| ¿Hay un **registro de aplicaciones emisoras**? | **Parcial** | Notify tiene `applications`, pero no se corresponde con las aplicaciones de la casa (hay *Demo*, *Procovar*, *Servidor*). Accesos tiene su propio registro, `client_app` (`pedido`, `analitics`, `aft`, `delivery`, `reparto`, `procovar-rutas`, `procovar-notify`…, ver `LLAVE_DEL_CLIENTE`). Los dos registros no se conocen. |
| ¿Cada **tipo de aviso pertenece a una aplicación**? | **Sí, pero a la aplicación de Notify, no a la de la casa** | `channel_routes.application_id` y nombre único por aplicación. Hoy «Procovar» agrupa todo lo de Accesos; «Servidor» lo de VPS y Reparto. No dice «este tipo es de PEDIDO». |
| ¿Una aplicación **declara qué avisos puede emitir**? | **No** | El tipo lo crea a mano un administrador en la SPA. La aplicación solo manda un nombre. No hay descripción para la persona, ni destinatarios previstos, ni ejemplo. |
| ¿Se sabe **a quién** va cada aviso? | **No** | Es una decisión del código del emisor, sin registro. Para saberlo hay que leer el código de cada aplicación. |
| ¿Cada persona puede **suscribirse o silenciar por aplicación y por tipo**? | **No** | Solo por canal y por aplicación de Notify, y **desde fuera** (no hay pantalla para ello). Además `handleOptOut` cancela por canal **sin distinguir tipos**: quien apague el correo deja de recibir también «recuperar contraseña». |
| ¿Se ve en la pantalla de configuración **agrupado por aplicación**? | **No** | La pantalla de Accesos es local y habla de reservas; la de Notify es de administración. |
| ¿Tiene una aplicación **su propio canal técnico**? | **Sí, si se le da su aplicación en Notify** | Clave propia, tipos propios, plantillas propias, SMTP propio, cuotas y auditoría propias. Es la parte que ya está construida. |

**La decisión de fondo (hay que tomarla antes de construir).** El plan de Notificaciones in-app
que dejó qb (`notify/docs/PLAN-NOTIFICACIONES-INAPP.md`, regla 0.1) dice **una sola aplicación
de Notify para todo el ecosistema**, porque la bandeja se consulta por `application_id` +
usuario: si cada aplicación de la casa fuera un inquilino distinto, la campana de una persona
tendría que pedir N bandejas y mezclarlas. Y a la vez «una aplicación = un canal» pide lo
contrario. Hay dos caminos:

| | A. Un inquilino de Notify por aplicación de la casa | B. Un inquilino (Procovar) y la aplicación como dato |
|---|---|---|
| Aislamiento de claves | Total: la clave de PEDIDO solo emite como PEDIDO. | Hay que forzarlo: la clave lleva su `source_app` y Notify lo sella; la petición no puede cambiarlo. |
| Bandeja de la campana | Fragmentada: N consultas, y «cuántos sin leer» hay que sumarlo. | Una consulta. Agrupar por aplicación es un filtro. |
| Preferencias «por aplicación» | Gratis (ya son por inquilino), pero siguen siendo solo por canal. | Hay que construirlas (tabla nueva), pero ya nacen por aplicación **y** por tipo. |
| Plantillas/SMTP propios | Propios de cada una. | Compartidos; se distinguen por tipo. |
| Esfuerzo | Medio: crear aplicaciones y claves; **la campana y las preferencias son lo difícil**. | Medio: una migración y tres endpoints. |

**Recomendación: B.** Es lo que pide Jose («de cada lado a cada usuario» = una vista por
persona, agrupada por origen), respeta la regla de una sola bandeja y no obliga a repartir
plantillas y SMTP. La seguridad de la clave se resuelve en el servidor (sección 4, paso 1).

---

## 3. La brecha, en una tabla

| Lo que pide Jose | Hoy | Falta |
|---|---|---|
| Cada aplicación tiene **su canal** | Técnicamente sí (inquilino), en la práctica no: tres aplicaciones y solo dos emisores | Que cada aplicación emita con **su** clave y se sepa de quién es cada aviso (`source_app`) |
| Que se sepa **qué avisa cada lado** | No hay catálogo | Descripción, aplicación, destinatarios previstos y si es obligatorio, por tipo |
| **A quién** va cada aviso | Lo decide el código del emisor | Un campo «destinatarios» en el tipo + que los emisores resuelvan personas con `/api/service/members` |
| Cada persona **ve** lo suyo | Panel y centro de avisos de Accesos (solo `IN_APP`, y nadie lo emite) | Que las aplicaciones emitan `IN_APP`; mostrar la aplicación de origen |
| Cada persona **configura** lo suyo, agrupado por aplicación | Pantalla local de adorno | Preferencias por tipo y canal en Notify, endpoints en Accesos y la pantalla |
| Los avisos **importantes** no se pueden silenciar por error | Un opt-out de canal los cancela todos | Marca `obligatorio` por tipo que el opt-out no pueda apagar |

---

## 4. Propuesta mínima, por pasos

Cada paso se puede desplegar solo y no rompe al anterior. Marcado: **existe** (reutilizar),
**construir**.

### Paso 0 — Decidir y fijar la lista de aplicaciones (media hora)

- Decidir A o B (arriba). Lo que sigue supone **B**.
- La lista de aplicaciones emisoras **es la de `client_app` de Accesos**, con su `clientId`
  (`pedido`, `analitics`, `delivery`, `reparto`, `procovar-rutas`, `aft`…), más `accesos` para lo
  que emite Accesos mismo (no es un `client_app`: no se autentica contra sí). Una sola fuente;
  Notify guarda ese `clientId` como texto, sin copiar el registro.

### Paso 1 — Notify: modelo de datos (construir; migración 00014)

- `api_keys.source_app text` — la aplicación de la casa a la que pertenece la clave.
- `notifications.source_app text` — **lo pone Notify a partir de la clave**, nunca el cuerpo de la
  petición (así una clave comprometida no suplanta a otra aplicación). Índice
  `(application_id, recipient_user_id, source_app, created_at DESC)`.
- `channel_routes` (los tipos): `source_app text`, `description_es`, `description_en` (lo que lee
  la persona, no el nombre técnico), `audience text` (`persona`, `rol`, `sucursal`,
  `operaciones`: a quién va, solo informativo), `mandatory boolean` (no silenciable),
  `default_enabled boolean`.
- Tabla **nueva** `user_type_preferences (application_id, user_id, notification_type, channel,
  enabled, PRIMARY KEY (…))`. La actual `user_notification_preferences` se queda como interruptor
  general por canal.
- En `handleOptOut` (`notification/service.go`): saltar el opt-out si el tipo es `mandatory`, y
  consultar la tabla nueva además de la general.
- Migrar lo existente: los cinco tipos de Accesos a `source_app = 'accesos'` con
  `mandatory = true` los de cuenta (verificación, recuperar contraseña), y `aviso-servidor` a
  `reparto`.

### Paso 2 — Notify: API `/v1` (construir)

- `GET /v1/catalog` (scope `read`): los tipos, con aplicación, descripción, canal, `audience` y
  `mandatory`. Es «qué avisa cada lado».
- `GET /v1/users/{userId}/preferences/types` y `PUT …/types/{type}/{channel}` (scope `read` para
  leer, `send` para escribir, como las actuales).
- `GET /v1/inbox/summary?userId=` → `[{ sourceApp, total, unread }]`, y `sourceApp` como filtro de
  `GET /v1/inbox`. Aprovechar para devolver **`total`** en la bandeja: el panel de Accesos deja
  de trocear 100 en memoria.
- Opcional, más tarde: `PUT /v1/catalog/types` (scope `send`) para que **la propia aplicación
  declare sus tipos al arrancar**, como Accesos ya hace con `syncRbac` y `syncClients`
  (idempotente, sin borrar). Mientras no exista, los da de alta el DESARROLLADOR en la pantalla
  de Notify, con los campos nuevos.

### Paso 3 — Notify: pantalla de administración (construir, pequeño)

- En la pestaña **Tipos de notificación** (`Routes.tsx`): los campos nuevos (aplicación, descripción,
  destinatarios, obligatorio).
- Una vista **Catálogo** de solo lectura, agrupada por aplicación. Es la respuesta a «¿qué avisa
  cada lado?» para quien administra.

### Paso 4 — Accesos: servidor (construir; mismo patrón que `_ownership.ts`)

- `src/lib/notify/inbox.ts`: `fetchCatalog`, `fetchTypePreferences`, `setTypePreference`. Mismo
  cliente firmado, solo servidor, que **no lanza** al interfaz.
- `GET /api/notifications/catalog` (el catálogo filtrado a lo que esa persona puede recibir) y
  `GET/PUT /api/notifications/preferences`. **El id de la persona sale siempre de la sesión**
  (`requireSessionUserId`); la petición solo dice tipo y canal, y se valida contra el catálogo.
- `GET /api/notifications/panel` pasa a pedir `total` y `sourceApp` a Notify (quitar el
  troceo en memoria de `src/lib/notify/panel.ts`).

### Paso 5 — Accesos: pantallas (construir)

- **Preferencias** — sustituir `NotificationsSection` (la de `localStorage`) por una pantalla
  **agrupada por aplicación**: PEDIDO, Analitics, Reparto, Rutas… y dentro, cada tipo con su
  descripción y un interruptor por canal (correo, pantalla). Los `obligatorio` salen con candado
  y sin interruptor. Va en el mismo sitio (`/profile#configurar-perfil`).
- Quitar **entero** lo que sobra (regla 6 de `procovar/CLAUDE.md`): `notificationSettings` y
  `updateNotificationSettings` del store `store.profile-data.ts`, y las claves
  `myProfile.notifications.*` de reservas, facturas y marketing. Buscar el nombre en todo el
  proyecto hasta que no quede ninguna referencia.
- **Panel de la campana** y centro de avisos: enseñar la aplicación de origen en cada aviso (y,
  si hace falta, un filtro por aplicación en `/profile/notifications`). El botón «Gestionar
  avisos» pasa a llevar a esa pantalla de preferencias, o a una pestaña dentro del centro.

### Paso 6 — Las aplicaciones emiten (construir, una a una)

Cada aplicación, con **su clave** (`source_app` sellado por Notify), sus tipos y su criterio de
destinatarios:

| Aplicación | Primer aviso razonable | Destinatarios |
|---|---|---|
| **Reparto** | Pasar de `aviso-servidor` + dirección fija a tipos propios (`reparto-canal-atascado`…) | Personas con rol `LOGISTICO` / `ADMINISTRADOR` de la sucursal, por `/api/service/members` |
| **PEDIDO** | Pedido rechazado o atascado, cierre del día | El gestor y el supervisor de esa sucursal |
| **Analitics** | Informe listo | Quien lo pidió |
| **Rutas** | Vendedor sin GPS | Supervisor de la sucursal |
| **Delivery** (el viejo) | Solo si se mantiene | — |
| **AFT** | Inventario pendiente | La económica |

Regla de siempre en este código: emitir es **disparar y olvidar**; un fallo de Notify nunca
rompe la operación que avisa (Reparto y Accesos ya lo hacen así). Y emitir con
`idempotencyKey` para no duplicar en reintentos.

### Qué existe y qué hay que construir

| Pieza | Estado |
|---|---|
| Inquilino por aplicación, claves, tipos, plantillas, SMTP, cuotas, supresiones, auditoría | **existe** |
| Bandeja `IN_APP`, leído, archivado, `archive-read` | **existe** |
| Preferencias por canal (API) | **existe**, sin pantalla y sin cliente |
| Entrada a la administración por Accesos con `avisos.entrar` | **existe** |
| Campana + panel paginado + centro de avisos | **existe** (panel nuevo, 08/10/2026) |
| `POST /api/service/members` para resolver destinatarios | **existe** |
| `source_app` en claves, tipos y avisos | construir (paso 1) |
| Catálogo (`/v1/catalog`) y su pantalla | construir (pasos 2 y 3) |
| Preferencias por tipo + `obligatorio` | construir (pasos 1 y 2) |
| Rutas y pantalla de preferencias en Accesos | construir (pasos 4 y 5) |
| Emisores en PEDIDO, Analitics, Reparto, Rutas, Delivery, AFT | construir (paso 6) |

**Orden recomendado:** 0, 1, 2 y 3 dan el catálogo («qué avisa cada lado») sin tocar a las
personas; 4 y 5 dan «cada usuario ve y gestiona lo suyo»; 6 se hace aplicación por aplicación,
empezando por Reparto, que ya emite.

---

## 5. Riesgos y permisos

- **Dos puertas distintas, no mezclarlas.** `avisos.entrar` (y `avisos.read/send/manage`) abre la
  pantalla de **administrar** Notify y es solo de DESARROLLADOR / administrador de sistema: así
  debe seguir. **Ver y configurar los avisos propios no pide esa llave**: lo hace cada persona
  desde Accesos, con su sesión. Las rutas nuevas de Accesos deben exigir solo sesión y tomar
  el id de la sesión, nunca de la petición.
- **La clave HMAC de lectura es de la aplicación y sirve para leer la bandeja de cualquiera.**
  Nunca debe llegar al navegador (hoy no llega: `inbox.ts` es solo servidor). Con una clave por
  aplicación emisora, las de emisión no llevan `notifications:read`.
- **Opt-out frente a avisos de cuenta.** Hoy apagar un canal cancela *todo* ese canal para esa
  persona, también «recuperar contraseña». Sin el campo `obligatorio` (paso 1), las
  preferencias por tipo serían un riesgo; con él, se pueden abrir sin miedo.
- **Preferencias de adorno.** La pantalla actual hace creer a la persona que ha silenciado algo
  cuando no es así. Es el hallazgo más urgente de la lista, aunque el rediseño no se haga ya.
- **Fugas entre sucursales.** Los avisos por sucursal los resuelve el emisor. Regla 1 de la casa:
  `ADMINISTRADOR` es de UNA sucursal; no resolver destinatarios con «¿contiene admin?».
- **Dependencia de Accesos.** Resolver destinatarios con `/api/service/members` hace que un aviso
  dependa de que Accesos conteste. Tiene que degradar a «sin aviso» (con registro), no a «falla
  la operación».
- **IN_APP vacío hoy.** Mientras ninguna aplicación emita `IN_APP`, el panel mostrará «No tienes
  avisos» y parecerá que no funciona. Conviene que el primer emisor del paso 6 sea de pantalla.
- **Límite del panel.** Las 100 más recientes, en 20 páginas de 5. Si la bandeja crece, hay que
  pasar a `total` o cursor (paso 2).
- **Datos de producción sin verificar hoy.** «Tres aplicaciones, siete tipos» sale de un
  comentario de Reparto fechado el 26/09/2026. Antes de migrar tipos hay que leer
  `channel_routes` y `applications` en el servidor (una sola conexión, según la regla de la casa).
