-- Firma de las APK (docs/firma-de-apk.md). SOLO ADITIVA: dos tablas nuevas, nada de lo existente se toca.
--
-- `firma_apk_clave` guarda la clave de firma de la casa CIFRADA (AES-256-GCM): la columna `cifrado` es ilegible sin
-- SERVICE_AUTH_SECRET. `firma_apk` es el historial de lo firmado.

CREATE TABLE IF NOT EXISTS "firma_apk_clave" (
    "id"          TEXT NOT NULL,
    "huella"      TEXT NOT NULL,
    "sujeto"      TEXT NOT NULL,
    "validoDesde" TIMESTAMP(3) NOT NULL,
    "validoHasta" TIMESTAMP(3) NOT NULL,
    "alias"       TEXT NOT NULL,
    "formato"     INTEGER NOT NULL DEFAULT 1,
    "cifrado"     BYTEA NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "firma_apk_clave_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "firma_apk" (
    "id"            TEXT NOT NULL,
    "clientId"      TEXT NOT NULL,
    "paquete"       TEXT NOT NULL,
    "versionName"   TEXT,
    "versionCode"   TEXT,
    "sha256Entrada" TEXT NOT NULL,
    "sha256Salida"  TEXT NOT NULL,
    "tamano"        INTEGER NOT NULL,
    "userId"        TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "firma_apk_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "firma_apk_createdAt_idx" ON "firma_apk"("createdAt");
