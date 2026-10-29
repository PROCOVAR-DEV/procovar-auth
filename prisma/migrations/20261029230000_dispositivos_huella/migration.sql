-- Dispositivos: lo que une a un mismo aparato físico es la HUELLA, no el X-Aparato-Id (cada APK genera el suyo: Android aísla el
-- almacenamiento por app). `dispositivo` pasa a ser el aparato físico (con `huella`) y el X-Aparato-Id baja a `dispositivo_app`
-- (la instalación). Aditiva y con relleno: lo que ya hubiera conserva su id de instalación.

ALTER TABLE "dispositivo" ADD COLUMN IF NOT EXISTS "huella" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_huella_key" ON "dispositivo"("huella");

ALTER TABLE "dispositivo_app" ADD COLUMN IF NOT EXISTS "aparatoId" TEXT;
UPDATE "dispositivo_app" a SET "aparatoId" = d."aparatoId" FROM "dispositivo" d WHERE d."id" = a."dispositivoId" AND a."aparatoId" IS NULL;
ALTER TABLE "dispositivo_app" ALTER COLUMN "aparatoId" SET NOT NULL;

DROP INDEX IF EXISTS "dispositivo_app_dispositivoId_clientId_key";
CREATE UNIQUE INDEX IF NOT EXISTS "dispositivo_app_clientId_aparatoId_key" ON "dispositivo_app"("clientId", "aparatoId");
CREATE INDEX IF NOT EXISTS "dispositivo_app_dispositivoId_idx" ON "dispositivo_app"("dispositivoId");

ALTER TABLE "dispositivo" DROP COLUMN IF EXISTS "aparatoId";
