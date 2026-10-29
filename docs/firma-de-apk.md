# Firma de las APK en Accesos

**Estado (29/10/2026): IMPLEMENTADO y probado en la rama `feat/firma-de-apk`; falta DESPLEGAR y hacer la importación única de la
clave** (Accesos es el login de todo: no se despliega sin orden de Jose). Decisión de Jose, dueño de Procovar: **la clave de firma
de la casa vive DENTRO de Accesos, cifrada en la base de datos.** Este documento dice qué se guarda, cómo se importa, cómo se rota
si algún día hace falta, y la regla que no se rompe.

## La regla: NO se genera una clave nueva. Nunca.

Android deja instalar una versión nueva ENCIMA de la vieja solo si las dos están firmadas con **el mismo certificado**. La clave
que firma Reparto y Transferencias hoy es la que está instalada en todos los teléfonos. Si se firmara una APK con otra clave:

- Reparto y Transferencias **no se actualizan encima**: el teléfono dice «la aplicación no se ha instalado» / conflicto de firma.
- La única salida es **desinstalar en cada teléfono** e instalar de cero, y **se pierde lo que no se haya subido** (la cola
  offline de Reparto, los SMS pendientes de Transferencias).

Por eso el código tiene la huella de la casa escrita (`HUELLA_DE_LA_CASA` en `src/lib/firma-apk-clave.ts`):

```
01529f5a6fb1a238985745aff13cdcf7e8e85b624992f4e328bde9898fd80b21   (SHA-256 del certificado; dato público)
```

- El script de importación **se niega** a importar un almacén que no dé esa huella.
- Cada firma se **verifica después** con `apksigner verify --print-certs` y, si el certificado del resultado no es ese, **no se
  entrega nada** (`huella_distinta`).

No hay en este repositorio ningún código que cree claves (`keytool -genkeypair` solo aparece en las pruebas, sobre un almacén de
juguete en `/tmp`).

## Qué se guarda y dónde

Tabla `firma_apk_clave` (migración `20261029240000_firma_de_apk`, solo aditiva), **una sola fila** (`id = 'casa'`):

| Columna | Qué es | ¿Secreto? |
|---|---|---|
| `huella` | SHA-256 del certificado | no (público) |
| `sujeto`, `validoDesde`, `validoHasta`, `alias` | datos del certificado | no (públicos) |
| `cifrado` | el **keystore (.jks) + la contraseña del almacén + la de la clave**, juntos | **sí: AES-256-GCM** |

- **Cifrado:** AES-256-GCM, IV nuevo de 12 bytes por cada cifrado, formato `[iv 12][etiqueta 16][texto cifrado]`. La huella va como
  dato autenticado (AAD): cambiar la columna `huella` sin la clave invalida el bloque.
- **La llave de cifrado se DERIVA** con HKDF-SHA256 de `SERVICE_AUTH_SECRET` (el mismo secreto del que cuelga `deriveSigningKey`).
  **No hay ninguna variable de entorno nueva** y no hay una segunda llave que guardar.
- Quien lee `cifrado` es solo `src/lib/firma-apk-clave.ts`. La pantalla usa `datosPublicos()`, que **ni pide** esa columna.
- La clave **no sale**: ni en las respuestas de la API, ni en los errores (solo un código y una frase), ni en la auditoría, ni en
  los logs, ni en git.

Tabla `firma_apk`: el historial (app, paquete, versión, sha256 de lo subido y de lo entregado, tamaño, quién y cuándo). Los
rechazos no entran ahí: van a la auditoría.

### Trampa: si cambia `SERVICE_AUTH_SECRET`

La clave guardada deja de poder descifrarse (la pantalla muestra «La clave guardada no se puede descifrar» al firmar). **No se pierde
nada**: el .jks original sigue en `.secretos`. Se vuelve a importar **después** del cambio, con `--sobrescribir` (ver abajo). Antes
de rotar ese secreto, acordarse de este paso: el resto de Accesos (firmas de servicio) también depende de él.

## La pantalla `/dashboard/firma-de-apk`

Solo el administrador global (como todo `/dashboard`). Muestra:

- el **certificado** (sujeto, huella SHA-256 con «Es la de siempre» / «NO es la esperada», validez, fecha de importación);
- **qué aplicaciones firma** y el `applicationId` permitido de cada una;
- el **historial** de las últimas 50 firmas;
- el formulario **«Firmar APK»**: se elige la aplicación, se sube la APK y se descarga la firmada.

### Qué aplicaciones y qué paquete — UN solo sitio: `src/lib/firma-apk-apps.ts`

| `clientId` | Aplicación | `applicationId` permitido | De dónde sale |
|---|---|---|---|
| `delivery-apk` | Reparto | `cloud.procovar.reparto` | `delivery-logistica/app/android/app/build.gradle.kts` |
| `transferencias-apk` | Transferencias | `cloud.procovar.transferencias` | `transferencia-sms/movil/android/app/build.gradle.kts` |
| `crm-apk` | CRM | `com.procovar.crm` | `crm/mobile/app.json` (Expo; **lo escribe Amado**: si lo cambia, se cambia aquí) |

El `package` del `AndroidManifest.xml` de lo que se sube tiene que ser **exactamente** uno de los de ESA aplicación (nada de
prefijos). Subir la APK de Reparto eligiendo «Transferencias» se rechaza. Para añadir otra aplicación: una línea en
`APPS_DE_FIRMA` y su `clientId` ha de estar en `CLIENTES_APK` de `apk-tokens.ts` (hay una prueba que lo comprueba).

## Cómo se firma (`POST /api/admin/firma-apk`)

Cuerpo: la APK tal cual, `Content-Type: application/octet-stream`, cabecera `X-Firma-App: <clientId>`. (No es `multipart`: así el
tope se aplica **leyendo el flujo**, sin tener la APK entera en memoria.) Respuesta: la APK firmada, con su SHA-256 en `X-Sha256`.

1. **Quién y desde dónde:** `requireSystemAdmin()` + `pedidoDeOtroSitio` (`Origin` propio, y tipo `application/octet-stream`: ni un
   formulario ni un `fetch` de otro sitio pasan sin CORS).
2. **Tope de 120 MB**, dos veces: si `Content-Length` ya lo pasa, 413 sin leer nada; y mientras se guarda, se corta al pasar del tope.
3. **Una firma a la vez.** Una segunda mientras hay una en curso recibe 429 (`firma_ocupada`); no hace cola.
4. La subida va a un directorio `procovar-firma-XXXX` (0700, de `mkdtemp`), con **nombres que inventa el servidor**
   (`entrada-<uuid>.apk`): del nombre que tenía el fichero no se lee nada. Se borra siempre (`finally`).
5. **Validación sin ejecutar nada de la APK** (`src/lib/firma-apk-manifest.ts`): ZIP real (por su directorio central), con
   `AndroidManifest.xml`; se descomprime **solo** esa entrada, con tope de 5 MB; se interpreta el XML binario (AXML) a mano y se
   saca `package`, `versionName`, `versionCode`. **Límite conocido:** si `versionName` es una referencia a un recurso
   (`@string/…`) sale vacío; el `package` nunca puede serlo (si no es un texto directo se rechaza).
6. **`zipalign`** solo si `zipalign -c 4` dice que no está alineada (Android 11+ no instala `resources.arsc` sin alinear).
7. **`apksigner sign`** con v2 y v3 (v1 lo decide apksigner según el `minSdk`). El keystore se descifra a un fichero 0600 en el
   directorio temporal y **se borra en cuanto acaba `sign`**. Las contraseñas pasan por variables de entorno del proceso hijo
   (`--ks-pass env:FIRMA_CLAVE_ALMACEN`, `--key-pass env:FIRMA_CLAVE_ALIAS`): **nunca en la línea de órdenes** (hay una prueba que
   espía los argumentos). El hijo no hereda `DATABASE_URL` ni `SERVICE_AUTH_SECRET`.
8. **Verificación del RESULTADO:** `apksigner verify --verbose --print-certs`; tiene que verificar con v2 **y** v3, con un único
   firmante, y su SHA-256 tiene que ser `HUELLA_DE_LA_CASA`. Si no, no se entrega.
9. Se escribe el historial (`firma_apk`; si esto falla, **no se entrega**) y la auditoría, y se devuelve el fichero.

Todos los procesos llevan **tiempo máximo** (180 s firmar, 60 s el resto) y se lanzan sin shell. Los errores salen como
`{ error: <código>, mensaje }` con una frase fija; el detalle (stderr de las herramientas) va solo al log del servidor.

### Auditoría (`src/lib/acciones-auditoria.ts`)

| Acción | Cuándo | `meta` |
|---|---|---|
| `apk.firmar` | firma entregada | app, versionName, versionCode, sha256Entrada, sha256Salida, tamano (+ `userId`, IP, UA) |
| `apk.firmar_rechazada` | cualquier rechazo | `motivo` (el código) |
| `apk.clave_importada` | la importación | huella, si fue sobrescritura |

## Importar la clave (UNA vez)

Lo hace quien despliega, **después** de desplegar la rama (la migración crea las tablas al arrancar el contenedor). Desde el
contenedor de Accesos (tiene el JRE y `SERVICE_AUTH_SECRET` y `DATABASE_URL`):

```bash
# 1. Sin tocar la base: ¿es este el .jks bueno? Dice «comprobada, huella …» o se niega.
npx tsx scripts/importar-clave-de-firma.ts --solo-comprobar --jks <procovar-reparto.jks> --claves <firma-apk-reparto.txt>

# 2. Importar de verdad (no pisa una clave ya importada).
npx tsx scripts/importar-clave-de-firma.ts --jks <procovar-reparto.jks> --claves <firma-apk-reparto.txt>
```

- Los dos ficheros se indican por argumento y no se copian a ningún sitio. Hay que llevarlos al contenedor por un medio que no deje
  copia (p. ej. `docker cp` y borrarlos después); **no meterlos en el repositorio ni en la imagen**.
- `--claves` admite `CLAVE_ALMACEN=` / `CLAVE_ALIAS=` / `ALIAS=` (el formato de `firma-apk-reparto.txt`), `clave: …` (una sola
  contraseña para las dos cosas) o una sola línea con la contraseña.
- El script comprueba con `keytool` la huella y que la contraseña de la CLAVE (no solo la del almacén) abre la clave privada.
- **Nunca imprime una contraseña ni su longitud.** Solo `importada, huella …`.
- Sin `--sobrescribir` no pisa una clave ya importada.
- En `/mnt/datos/Work/procovar/.secretos` hay dos candidatos. Comprobado el 29/10/2026 con `--solo-comprobar` (sin base):
  **`procovar-reparto.jks` + `firma-apk-reparto.txt` SÍ da la huella de la casa**; `reparto-firma.jks` + `reparto-firma.txt`
  da otra (`d1a8b89b…`) y **NO es la buena**.

## Si algún día hay que rotar o repetir algo

| Caso | Qué hacer |
|---|---|
| Cambió `SERVICE_AUTH_SECRET` | Volver a importar con `--sobrescribir` (mismo .jks). |
| Se perdió la fila (restauración de una copia vieja) | Importar de nuevo; la migración es idempotente. |
| El certificado caduca (la pantalla lo avisa con «Caducado») | El de hoy (`CN=Procovar Reparto, OU=Logistica, O=Procovar, L=La Habana, C=CU`, alias `reparto`) vale hasta el 06/02/2054. Llegado el momento, **no se cambia la clave sin una migración de firma pensada** (rotación v3 con `apksigner rotate`, que permite a Android aceptar una cadena de certificados). No improvisar. |
| Se sospecha que la clave se filtró | Es una decisión de Jose, no un botón: significa **cambiar la firma de todas las apps** (ver «La regla»). Primero revocar el acceso a la base, después planificar la desinstalación en los teléfonos. |

## Docker

La imagen necesita un JRE y las dos herramientas (`Dockerfile`, etapa final):

- **JRE:** `openjdk21-jre-headless` de Alpine (lleva `keytool`). La **mayor** va fijada; Alpine no deja fijar la menor sin que el
  build falle el día que la retire.
- **`apksigner.jar` y `zipalign`:** build-tools **35.0.0**, **dentro del repositorio** en `docker/firma-apk/` (2,4 MB) con su
  `SHA256SUMS`, que el `Dockerfile` comprueba (`sha256sum -c`): un fichero tocado rompe el build. Se copiaron del SDK de Android de
  Jose a propósito, y no se descargan: `dl.google.com` no responde desde Cuba (todo 404 el 29/10/2026) y un `Dockerfile` que
  depende de un tercero no es reproducible. Hay `apksigner` y `zipalign` como scripts en `/usr/local/bin`.
- **Trampa de Alpine (musl):** `zipalign` de Google es un binario de **glibc**. Corre con el paquete `gcompat` más su propia
  `libc++.so` (`docker/firma-apk/lib64`, resuelta por su `RUNPATH $ORIGIN/lib64`): **probado** en `alpine:3.24`. `apksigner.jar` es
  Java puro y no tiene problema.
- **Tamaño:** medido el 29/10/2026, el JRE + `gcompat` suman **~202 MB** a la imagen y las herramientas 2,4 MB (la imagen ya era
  grande por el `node_modules` completo). Si molestara, la salida es un runtime mínimo con `jlink` en una etapa aparte (queda
  por probar qué módulos necesitan `apksigner` y `keytool`); no se hizo para no complicar un `Dockerfile` que construye el login de todo.
- **Comprobado el 29/10/2026:** la imagen se construye con `docker build`, arranca (`Ready`, migraciones y semilla al arrancar) y,
  DENTRO de ella y como usuario `nextjs`, se descifra la clave desde la base, se firma una APK y `apksigner verify` da la huella de
  la casa.
- **No se tocó `docker-entrypoint.sh`.**
- `Dockerfile.staging` **no** se ha tocado: en staging la pantalla funciona pero firmar da «Este servidor no tiene las herramientas
  de firma» (`herramienta_no_disponible`). Si hace falta firmar en staging, copiar el mismo bloque.

Variables **opcionales** (solo para desarrollo en un portátil con el SDK de Android; en la imagen no hacen falta):
`APKSIGNER`, `ZIPALIGN`, `KEYTOOL` (ruta de cada herramienta).

## Límites que hay que conocer

- **Cloudflare:** si `auth.procovar.cloud` pasa por el proxy de Cloudflare (nube naranja) en un plan Free/Pro, **rechaza cuerpos de
  más de 100 MB**. El tope de la aplicación es 120 MB; una APK entre 100 y 120 MB no llegaría. Las APK de hoy pesan bastante menos.
- La firma es **síncrona**: la petición dura lo que tarde Java (unos segundos para una APK normal). Hay `maxDuration = 300`.
- Una sola réplica del contenedor: «una firma a la vez» es por proceso, no entre réplicas.
- El CRM es de Amado: confirmar que su `applicationId` real es `com.procovar.crm` antes de firmar la primera.

## Pendiente (no se implementó a propósito)

- **Publicar la APK firmada en MinIO** (que la pantalla deje la firmada en un bucket además de ofrecer la descarga). El gancho está
  marcado con un `TODO` en `src/lib/firma-apk.ts` (`firmarArchivo`, tras la verificación). Falta que Jose diga **qué bucket** y con qué
  nombre/ciclo de vida; las credenciales están en `.secretos/minio.txt` y no se tocan hasta entonces.

## Pruebas

`npx vitest run --exclude ".claude/**" --exclude "node_modules/**"` (las de firma se saltan solas si el equipo no tiene `java`,
`keytool`, `apksigner` y `zipalign`):

- `firma-apk-apps.test.ts` — la lista blanca.
- `firma-apk-manifest.test.ts` — el ZIP y el AXML, con APK **reales** fabricadas por `aapt2` (`__tests__/fixtures/`) y casos malos
  (basura, cortadas, bombas de compresión, AXML con un byte tocado).
- `firma-apk-clave.test.ts` — el cifrado.
- `firma-apk.test.ts` — **de extremo a extremo** con un keystore de juguete: firma, `apksigner verify` aparte, alineación, huella
  distinta → no se entrega, contraseñas fuera de logs y de la línea de órdenes, tope de subida, una firma a la vez.
- `firma-apk-importar.test.ts` — el fichero de contraseñas, `keytool`, y el script (se niega con otra huella).
- `app/api/admin/firma-apk/__tests__/route.test.ts` — la ruta entera.
