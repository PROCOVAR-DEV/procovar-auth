-- Código del almacén (el `objectCode` de Ventra).
--
-- Sin él, Reparto no sabe de qué almacén sale cada pedido (el pedido trae el código, Accesos no tenía
-- dónde guardarlo) y mide TODOS desde el almacén principal de la sucursal. Se rellena desde la pantalla
-- de Almacenes de Reparto, que lo manda en el PUT de /api/service/almacenes.
--
-- Columna nueva y NULLABLE: ningún almacén existente cambia. Índice único por (sucursal, código): el
-- mismo número es otro almacén en otra sucursal, y Postgres no cuenta los NULL, así que los que aún no
-- tienen código no chocan entre sí.
ALTER TABLE "Almacen" ADD COLUMN IF NOT EXISTS "codigo" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Almacen_orgId_codigo_key" ON "Almacen"("orgId", "codigo");
