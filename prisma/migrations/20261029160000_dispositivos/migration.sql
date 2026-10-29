-- Registro central de dispositivos (docs/dispositivos.md). SOLO ADITIVA: tablas nuevas y una columna nula.
-- Nada de lo que ya funciona (sesiones, refresh, login) lee ni escribe esto salvo el reconocimiento de las cabeceras
-- `X-Aparato-*` en /api/auth/refresh y /api/auth/token, que no puede fallar la petición.
--
-- UN APARATO FÍSICO = UNA FILA (`dispositivo`, único por `aparatoId`); en cuántas aplicaciones está cuelga de `dispositivo_app`
-- (versión, sesión, estado, bloqueo POR APLICACIÓN); y qué cuentas entraron en cada una, de `dispositivo_persona`.

ALTER TABLE "client_app" ADD COLUMN IF NOT EXISTS "dispositivosUrl" TEXT;

CREATE TABLE IF NOT EXISTS "dispositivo" (
    "id"         TEXT NOT NULL,
    "aparatoId"  TEXT NOT NULL,
    "plataforma" TEXT,
    "equipo"     TEXT,
    "nombre"     TEXT,
    "ipUltima"   TEXT,
    "userAgent"  TEXT,
    "primeraVez" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vistoAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dispositivo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_aparatoId_key" ON "dispositivo"("aparatoId");

CREATE TABLE IF NOT EXISTS "dispositivo_app" (
    "id"             TEXT NOT NULL,
    "dispositivoId"  TEXT NOT NULL,
    "clientId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "sucursal"       TEXT,
    "version"        TEXT,
    "primeraVez"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vistoAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ultimaDescarga" TIMESTAMP(3),
    "ultimaSubida"   TIMESTAMP(3),
    "pendientes"     INTEGER,
    "rechazados"     INTEGER,
    "ultimoError"    TEXT,
    "estadoAt"       TIMESTAMP(3),
    "familyId"       TEXT,
    "bloqueadoAt"    TIMESTAMP(3),
    "bloqueadoPor"   TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dispositivo_app_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_app_dispositivoId_clientId_key" ON "dispositivo_app"("dispositivoId", "clientId");
CREATE INDEX IF NOT EXISTS "dispositivo_app_clientId_updatedAt_id_idx" ON "dispositivo_app"("clientId", "updatedAt", "id");
CREATE INDEX IF NOT EXISTS "dispositivo_app_userId_idx" ON "dispositivo_app"("userId");
ALTER TABLE "dispositivo_app" DROP CONSTRAINT IF EXISTS "dispositivo_app_dispositivoId_fkey";
ALTER TABLE "dispositivo_app" ADD CONSTRAINT "dispositivo_app_dispositivoId_fkey"
    FOREIGN KEY ("dispositivoId") REFERENCES "dispositivo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dispositivo_app" DROP CONSTRAINT IF EXISTS "dispositivo_app_userId_fkey";
ALTER TABLE "dispositivo_app" ADD CONSTRAINT "dispositivo_app_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TODAS las cuentas que han entrado en cada aparato y aplicación (un mismo PC lo usan varias personas); `dispositivo_app.userId` es solo la última.
CREATE TABLE IF NOT EXISTS "dispositivo_persona" (
    "id"               TEXT NOT NULL,
    "dispositivoAppId" TEXT NOT NULL,
    "userId"           TEXT NOT NULL,
    "sucursal"         TEXT,
    "version"          TEXT,
    "primeraVez"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vistoAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dispositivo_persona_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_persona_dispositivoAppId_userId_key" ON "dispositivo_persona"("dispositivoAppId", "userId");
CREATE INDEX IF NOT EXISTS "dispositivo_persona_userId_idx" ON "dispositivo_persona"("userId");
ALTER TABLE "dispositivo_persona" DROP CONSTRAINT IF EXISTS "dispositivo_persona_dispositivoAppId_fkey";
ALTER TABLE "dispositivo_persona" ADD CONSTRAINT "dispositivo_persona_dispositivoAppId_fkey"
    FOREIGN KEY ("dispositivoAppId") REFERENCES "dispositivo_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dispositivo_persona" DROP CONSTRAINT IF EXISTS "dispositivo_persona_userId_fkey";
ALTER TABLE "dispositivo_persona" ADD CONSTRAINT "dispositivo_persona_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- El CRM (credencial de servicio `crm`) puede leer y gestionar SOLO los aparatos de su APK (`crm-apk`): la aplicación sale de los
-- scopes de la credencial (`dispositivos:<clientId>`), no de lo que mande. Idempotente; sin efecto si no existe ese cliente.
UPDATE "client_app"
   SET "scopes" = array_append("scopes", 'dispositivos:crm-apk')
 WHERE "clientId" = 'crm' AND NOT ('dispositivos:crm-apk' = ANY("scopes"));
