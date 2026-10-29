-- Registro central de dispositivos (docs/dispositivos.md). SOLO ADITIVA: una tabla nueva y una columna nula.
-- Nada de lo que ya funciona (sesiones, refresh, login) lee ni escribe esto salvo el reconocimiento de las cabeceras
-- `X-Aparato-*` en /api/auth/refresh y /api/auth/token, que no puede fallar la petición.

ALTER TABLE "ClientApp" ADD COLUMN IF NOT EXISTS "dispositivosUrl" TEXT;

CREATE TABLE IF NOT EXISTS "dispositivo" (
    "id"             TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "clientId"       TEXT NOT NULL,
    "aparatoId"      TEXT NOT NULL,
    "plataforma"     TEXT,
    "version"        TEXT,
    "equipo"         TEXT,
    "nombre"         TEXT,
    "sucursal"       TEXT,
    "ipUltima"       TEXT,
    "userAgent"      TEXT,
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
    CONSTRAINT "dispositivo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_clientId_aparatoId_key" ON "dispositivo"("clientId", "aparatoId");
CREATE INDEX IF NOT EXISTS "dispositivo_userId_idx" ON "dispositivo"("userId");
CREATE INDEX IF NOT EXISTS "dispositivo_clientId_vistoAt_idx" ON "dispositivo"("clientId", "vistoAt");

ALTER TABLE "dispositivo" DROP CONSTRAINT IF EXISTS "dispositivo_userId_fkey";
ALTER TABLE "dispositivo" ADD CONSTRAINT "dispositivo_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
