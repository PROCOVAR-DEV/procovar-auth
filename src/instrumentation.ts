/**
 * Runs once per server instance at startup (Next.js instrumentation).
 * Auto-syncs the RBAC catalog (permissions + system roles) and the registered
 * client applications into the DB so a fresh deploy always has them — no manual
 * CLI step. Idempotent and best-effort: a failure (e.g. DB briefly unreachable)
 * never blocks boot.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { syncRbac } = await import('@/rbac/sync')
    const res = await syncRbac()
    console.log('[rbac] auto-sync on boot:', res)
  } catch (e) {
    console.error('[rbac] auto-sync failed (non-fatal):', e)
  }
  try {
    const { syncClients } = await import('@/lib/sync-clients')
    const res = await syncClients()
    console.log('[clients] auto-sync on boot:', res)
  } catch (e) {
    console.error('[clients] auto-sync failed (non-fatal):', e)
  }
  // Purga de sesiones y refresh caducados (hace más de 30 días): una ahora, sin esperarla, y cada 24 h.
  try {
    const { arrancarPurga } = await import('@/lib/purga-caducadas')
    arrancarPurga()
    console.log('[purga] programada: al arrancar y cada 24 h')
  } catch (e) {
    console.error('[purga] no se pudo programar (non-fatal):', e)
  }
}
