import 'dotenv/config'
import { prisma } from '../src/lib/prisma'
import { REPARTO_KEYS } from '../src/rbac/system-roles'
import { ROLES_SIN_REPARTO, aplicar, leer, motivoParaNoAplicar, type DbRetirar, type Lectura } from '../src/rbac/retirar-reparto'

/**
 * Quitar Reparto a GESTOR, OPERADOR, SUPERVISOR y GERENTE en la base.
 *
 * Jose, 08/10/2026: «los logísticos, admins, superadmins y desarrolladores son los
 * únicos que pueden entrar a Reparto; a los otros quítales esos permisos».
 *
 * Por qué hace falta: `sync.ts` solo SIEMBRA, nunca quita. Cambiar `system-roles.ts`
 * no le quita nada a los roles que ya existen en producción.
 *
 *   npx tsx scripts/retirar-reparto-de-roles.ts             SOLO MUESTRA, no escribe
 *   npx tsx scripts/retirar-reparto-de-roles.ts --aplicar   borra, en UNA transacción
 *
 * ORDEN: primero se despliega Accesos (al arrancar, `syncRbac` crea el rol LOGISTICO
 * con sus llaves y ya no vuelve a sembrar Reparto a los otros cuatro), y DESPUÉS esto.
 * Si se corre antes, un arranque con el código viejo se las devolvería. Por eso
 * `--aplicar` se niega mientras LOGISTICO no exista.
 *
 * Idempotente: la segunda vez no encuentra nada que quitar. Solo toca esos cuatro roles
 * y solo las llaves del servicio `delivery`; ADMINISTRADOR, SUPER ADMIN, DESARROLLADOR
 * y LOGISTICO no se tocan.
 */
const db = prisma as unknown as DbRetirar

function pintar(titulo: string, l: Lectura) {
  console.log(`\n${titulo}`)
  for (const r of l.roles) {
    console.log(
      `  ${r.name.padEnd(11)} ${String(r.reparto.length).padStart(2)} llaves de Reparto` +
        `  (${r.membresias} membresías, ${r.porDefecto} con este rol por defecto)` +
        (r.reparto.length ? `\n              ${r.reparto.join(', ')}` : ''),
    )
  }
  const faltan = ROLES_SIN_REPARTO.filter((n) => !l.roles.some((r) => r.name === n))
  if (faltan.length) console.log(`  (no existen en la base: ${faltan.join(', ')})`)
}

async function main() {
  const escribir = process.argv.includes('--aplicar')
  console.log(`Llaves de Reparto (servicio delivery): ${REPARTO_KEYS.length}`)

  const antes = await leer(db)
  pintar('AHORA', antes)

  const { existe, faltan } = antes.logistico
  console.log(`\n  LOGISTICO: ${existe ? 'existe' : 'NO existe todavía'}`)
  if (existe && faltan.length) {
    console.log(`  OJO: le faltan ${faltan.join(', ')} (completar-roles.ts las añade, sin quitar nada).`)
  }

  const porQuitar = antes.roles.reduce((n, r) => n + r.reparto.length, 0)
  const conGente = antes.roles.filter((r) => r.reparto.length && (r.membresias || r.porDefecto))
  if (conGente.length) {
    console.log(
      `\n  AVISO: esta gente dejará de entrar a Reparto si no tiene también LOGISTICO, ADMINISTRADOR,` +
        ` SUPER ADMIN o DESARROLLADOR: ${conGente.map((r) => r.name).join(', ')}.`,
    )
  }

  if (!escribir) {
    console.log(`\nSOLO MUESTRA: quitaría ${porQuitar} filas de role_permission. Para escribir: --aplicar`)
    return
  }
  const motivo = motivoParaNoAplicar(antes)
  if (motivo) {
    console.error(`\nNo se aplica: ${motivo}`)
    process.exit(2)
  }

  const r = await aplicar(db)
  pintar('DESPUÉS', r.despues)
  console.log(`\n${r.filas} filas de role_permission borradas.`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
