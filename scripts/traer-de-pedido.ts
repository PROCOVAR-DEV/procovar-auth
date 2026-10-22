import 'dotenv/config'
import { Client } from 'pg'
import { prisma } from '../src/lib/prisma'

/**
 * Traer a Accesos las personas que hoy viven en PEDIDO, con su contraseña.
 *
 * Accesos pasa a ser el maestro de personas de la operación. Esto NO migra PEDIDO
 * —que sigue funcionando igual— sino que deja aquí los datos listos para el día que
 * se migre: quién es cada uno, su sucursal, su rol, su código de vendedor y si sigue
 * en la organización.
 *
 * Lo importante que se descubrió mirando los datos, y que da forma a todo esto:
 * **vendedor y usuario son la misma persona**. En PEDIDO son dos tablas y un campo
 * llamado `gestorId` que parece decir "quién lo manda" pero guarda la cuenta del
 * propio vendedor — 82 de 82, uno a uno, sin una excepción. Aquí es una sola
 * persona con un campo `codigoVendedor`, y desaparece el emparejamiento.
 *
 * El hash de la contraseña se copia SIN TOCAR: son bcrypt (`$2b$`, las 153) y
 * `auth.ts` sabe leerlas. Cada uno seguirá entrando con la suya.
 *
 * Se puede correr las veces que haga falta: a quien ya esté se le completan los
 * datos nuevos, pero no se le pisa el rol ni la contraseña.
 */

/** El rol de Accesos que le corresponde a cada rol de PEDIDO. */
const ROLES: Record<string, string> = {
    'Super Admin': 'SUPER ADMIN',
    'Administrador': 'ADMINISTRADOR',
    'Supervisor': 'SUPERVISOR',
    'Operador': 'OPERADOR',
    'Gestor': 'GESTOR',
}

async function main() {
    const url = process.env.PEDIDO_DATABASE_URL
    if (!url) {
        console.error('falta PEDIDO_DATABASE_URL')
        process.exit(2)
    }

    const cliente = new Client({ connectionString: url })
    await cliente.connect()

    const { rows } = await cliente.query<{
        username: string
        password: string | null
        rol: string | null
        sucursal: string | null
        codigo_vendedor: string | null
        activo: boolean
    }>(`
        SELECT u.username,
               u.password,
               r.rol    AS rol,
               s.codigo AS sucursal,
               v.code   AS codigo_vendedor,
               COALESCE(v.activo, true) AS activo
          FROM "User" u
          LEFT JOIN "Roles"    r ON r.id = u."roleId"
          LEFT JOIN "Sucursal" s ON s.id = u."sucursalId"
          -- El vendedor cuya CUENTA es esta persona.
          LEFT JOIN "Seller"   v ON v."gestorId" = u.id
         WHERE u.username IS NOT NULL AND u.username <> ''
         ORDER BY u.username
    `)
    await cliente.end()

    console.log(`  en PEDIDO hay ${rows.length} cuentas`)

    const roles = await prisma.role.findMany({ select: { id: true, name: true } })
    const rolPorNombre = new Map(roles.map((r) => [r.name, r.id]))
    const sucursales = await prisma.organization.findMany({ select: { id: true, codigo: true } })
    // Por el CÓDIGO (CAM, PLS…), que es el de PEDIDO: el slug de Palma Soriano es «palma-soriano» y no casaba.
    const porCodigo = new Map(sucursales.filter((s) => s.codigo).map((s) => [s.codigo!.toUpperCase(), s.id]))

    let traidas = 0, completadas = 0, saltadas = 0

    for (const p of rows) {
        const username = p.username.trim()
        const nombreRol = ROLES[p.rol ?? ''] ?? 'OPERADOR'
        const roleId = rolPorNombre.get(nombreRol)
        if (!roleId) {
            console.log(`  ${username}: no existe el rol ${nombreRol}, se salta`)
            saltadas++
            continue
        }

        const esGlobal = nombreRol === 'SUPER ADMIN'
        const sucursalId = p.sucursal ? porCodigo.get(p.sucursal.toUpperCase()) : undefined

        const existente = await prisma.user.findFirst({
            where: { username },
            select: { id: true, defaultRoleId: true },
        })

        // El código de vendedor es único: si ya lo lleva OTRA cuenta, casi seguro es la misma
        // persona con otro usuario (leodan.quesada / leodan.quedada, 21/10/2026). Crearla la
        // duplicaría y el índice único tumbaba el script entero: se salta y se dice.
        if (p.codigo_vendedor) {
            const duena = await prisma.user.findFirst({
                where: { codigoVendedor: p.codigo_vendedor, ...(existente ? { id: { not: existente.id } } : {}) },
                select: { username: true, email: true },
            })
            if (duena) {
                console.log(`  ${username}: el código ${p.codigo_vendedor} ya es de ${duena.username ?? duena.email}, se salta (revisar a mano)`)
                saltadas++
                continue
            }
        }

        if (existente) {
            // A quien ya estaba se le COMPLETA lo nuevo, no se le pisa lo que tiene:
            // puede habérsele ajustado el rol a mano aquí, y esto no viene a deshacerlo.
            await prisma.user.update({
                where: { id: existente.id },
                data: {
                    codigoVendedor: p.codigo_vendedor || null,
                    activo: p.activo,
                    // Solo se le pone rol a quien NO tenga: si ya tiene uno, puede
                    // habersele ajustado a mano aqui y esto no viene a deshacerlo.
                    ...(existente.defaultRoleId ? {} : { defaultRole: { connect: { id: roleId } } }),
                },
            })
            completadas++
            continue
        }

        await prisma.$transaction(async (tx) => {
            const u = await tx.user.create({
                data: {
                    name: username,
                    username,
                    // El correo es obligatorio para better-auth. Quien no tiene recibe
                    // uno interno que no recibe nada: es una clave técnica, no una
                    // dirección que alguien deba saberse.
                    email: `${username}@procovar.local`,
                    // Venían de un sistema donde ya trabajaban: no se les manda a
                    // verificar un correo para poder seguir entrando.
                    emailVerified: true,
                    isSystemAdmin: esGlobal,
                    // Prisma 7 pide la relacion, no el campo escalar.
                    defaultRole: { connect: { id: roleId } },
                    codigoVendedor: p.codigo_vendedor || null,
                    activo: p.activo,
                },
                select: { id: true },
            })

            if (p.password) {
                // El hash se copia SIN TOCAR: es bcrypt y `auth.ts` sabe leerlo.
                await tx.account.create({
                    data: { userId: u.id, accountId: u.id, providerId: 'credential', password: p.password },
                })
            }

            // Un Super Admin no pertenece a ninguna sucursal: las ve todas.
            if (!esGlobal && sucursalId) {
                await tx.member.create({
                    data: {
                        userId: u.id,
                        organizationId: sucursalId,
                        role: nombreRol,
                        memberRoles: { create: { roleId } },
                    },
                })
            }
        })

        traidas++
    }

    const conCodigo = await prisma.user.count({ where: { codigoVendedor: { not: null } } })
    const bajas = await prisma.user.count({ where: { activo: false } })
    console.log(`\n  ${traidas} traídas · ${completadas} ya estaban (completadas) · ${saltadas} saltadas`)
    console.log(`  con código de vendedor: ${conCodigo}`)
    console.log(`  marcadas como baja:     ${bajas}`)
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1) })
