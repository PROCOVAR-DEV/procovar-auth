/**
 * Cada acción del panel que cambia lo que una aplicación sabe de una persona AVISA, con
 * el tipo y las personas correctas, y sólo DESPUÉS de que la base lo hiciera: si la
 * operación falla, no se avisa de algo que no pasó.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => {
  const d: Record<string, unknown> = {
    user: { update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    account: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    session: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    refreshToken: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    member: { findUnique: vi.fn(), delete: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    memberRole: { findMany: vi.fn(), create: vi.fn(), deleteMany: vi.fn(), upsert: vi.fn(), findFirst: vi.fn() },
    role: { findUnique: vi.fn(), findMany: vi.fn() },
    rolePermission: { deleteMany: vi.fn(), createMany: vi.fn(), findMany: vi.fn() },
    permission: { findMany: vi.fn() },
    organization: { update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
    almacen: { deleteMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  }
  d.$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(d) : Promise.all(arg as unknown[]),
  )
  return d as Record<string, Record<string, ReturnType<typeof vi.fn>>> & { $transaction: ReturnType<typeof vi.fn> }
})
const sesion = vi.hoisted(() => ({ getCurrentUser: vi.fn() }))
const alta = vi.hoisted(() => ({ altaPersona: vi.fn(), esSuperAdmin: vi.fn(() => false) }))
const avisos = vi.hoisted(() => ({
  publicarSesionCerrada: vi.fn(async () => {}),
  publicarPermisosCambiados: vi.fn(async () => {}),
  personasConRol: vi.fn(async () => ['p1', 'p2']),
  personasDeLaSucursal: vi.fn(async () => ['s1', 's2']),
}))
const redis = vi.hoisted(() => ({
  set: vi.fn(async () => 'OK'),
  pipeline: vi.fn(() => ({ set: vi.fn(), exec: vi.fn(async () => []) })),
}))

vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/server/auth.server', () => sesion)
vi.mock('@/lib/alta-persona', () => alta)
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('@/lib/redis', () => ({ getRedis: () => redis }))
vi.mock('@/lib/eventos-de-sesion', () => avisos)
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('better-auth/crypto', () => ({ hashPassword: vi.fn(async () => 'hash') }))
// Estas pruebas son del AVISO, no del escalafón (eso está en rbac/__tests__ y anadir-persona.test).
vi.mock('@/rbac/en-sucursal', () => ({ rbacEnSucursal: vi.fn(async () => ({})), rolesEnSucursal: vi.fn(async () => []) }))
vi.mock('@/rbac/can', () => ({ can: () => true }))
vi.mock('@/rbac/escalafon', () => ({ puedeRepartirRol: () => true }))

import {
  anadirPersona,
  agregarMiembro,
  restablecerPermisosDelRol,
  toggleUserAdmin,
  adminDeleteUser,
  cambiarContrasena,
  cambiarRol,
  revokeUserSession,
  revokeAllUserSessions,
  removeOrgMember,
  setOrgMemberRoles,
  updateOrganizationAdmin,
  deleteOrganizationAdmin,
} from '../_actions'
import { logger } from '@/lib/logger'

const ADMIN = { id: 'admin-1', isSystemAdmin: true }
const rol = { id: 'r1', name: 'GESTOR', permissions: [] }

beforeEach(() => {
  // Reset de verdad: un `mockRejectedValue` de una prueba no puede colarse en la siguiente.
  vi.resetAllMocks()
  db.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(db) : Promise.all(arg as unknown[]),
  )
  alta.esSuperAdmin.mockReturnValue(false)
  redis.set.mockResolvedValue('OK')
  redis.pipeline.mockReturnValue({ set: vi.fn(), exec: vi.fn(async () => []) })
  sesion.getCurrentUser.mockResolvedValue({ data: ADMIN })
  avisos.personasConRol.mockResolvedValue(['p1', 'p2'])
  avisos.personasDeLaSucursal.mockResolvedValue(['s1', 's2'])
  db.role.findUnique.mockResolvedValue({ ...rol })
  db.role.findMany.mockResolvedValue([{ ...rol }])
  db.permission.findMany.mockResolvedValue([{ id: 'pm1' }])
  db.session.updateMany.mockResolvedValue({ count: 2 })
  db.session.findMany.mockResolvedValue([])
  db.session.update.mockResolvedValue({ userId: 'u-objetivo' })
  db.member.findUnique.mockResolvedValue({
    id: 'm1', userId: 'u-miembro', organizationId: 'org1', role: 'GESTOR',
    user: { email: 'x@y' }, organization: { name: 'CAM' },
  })
  db.memberRole.findMany.mockResolvedValue([{ roleId: 'vieja' }])
  db.account.findFirst.mockResolvedValue({ id: 'acc1' })
  db.user.findUnique.mockResolvedValue({ email: 'x@y', defaultRoleId: 'r1', isSystemAdmin: false, defaultRole: null })
  db.rolePermission.findMany.mockResolvedValue([])
  db.organization.findUnique.mockResolvedValue({ activa: true, codigo: 'CAM' })
  db.member.findFirst.mockResolvedValue(null)
  db.member.create.mockResolvedValue({ id: 'm-nuevo' })
  alta.altaPersona.mockResolvedValue({ userId: 'u-nuevo', memberId: 'm-nuevo' })
})

const nadieAvisado = () => {
  expect(avisos.publicarSesionCerrada).not.toHaveBeenCalled()
  expect(avisos.publicarPermisosCambiados).not.toHaveBeenCalled()
}

describe('sesion-cerrada', () => {
  it('revokeUserSession → revocada, para el dueño de ESA sesión', async () => {
    await revokeUserSession('s1')
    expect(db.session.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 's1' } }))
    expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u-objetivo'], 'revocada')
  })
  it('revokeUserSession que falla → no avisa', async () => {
    db.session.update.mockRejectedValue(new Error('no existe'))
    expect((await revokeUserSession('s1')).error).toBeTruthy()
    nadieAvisado()
  })

  it('revokeAllUserSessions → revocada', async () => {
    await revokeAllUserSessions('u9')
    expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u9'], 'revocada')
  })
  it('revokeAllUserSessions que falla → no avisa', async () => {
    db.session.updateMany.mockRejectedValue(new Error('db'))
    await revokeAllUserSessions('u9')
    nadieAvisado()
  })

  it('cambiarContrasena (cierra sus sesiones) → revocada', async () => {
    await cambiarContrasena('u9', 'una-clave-larga')
    expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u9'], 'revocada')
  })
  it('cambiarContrasena cierra también los refresh de la APK de ESA persona (y sólo de ella)', async () => {
    await cambiarContrasena('u9', 'una-clave-larga')
    expect(db.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u9', revokedAt: null }, data: { revokedAt: expect.any(Date) } }),
    )
  })
  it('cambiarContrasena: si cerrar los refresh FALLA, la clave ya cambió → no revienta, avisa «revocada» igualmente y deja el error en el registro', async () => {
    db.refreshToken.findMany.mockRejectedValue(new Error('base caída con datos de ana@procovar.local'))
    const r = await cambiarContrasena('u9', 'una-clave-larga')
    expect(r).toEqual({ sesionesCerradas: 2 }) // sin `error`: la operación salió bien
    expect(db.account.update).toHaveBeenCalled() // la clave se cambió
    expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u9'], 'revocada')
    expect(logger.error).toHaveBeenCalledOnce()
    // userId interno y nombre del error: ni el mensaje (puede traer datos personales) ni la clave
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('refresh'), { userId: 'u9', error: 'Error' })
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain('una-clave-larga')
  })
  it('cambiarContrasena con clave corta o con fallo → no avisa', async () => {
    await cambiarContrasena('u9', 'corta')
    db.session.updateMany.mockRejectedValue(new Error('db'))
    await cambiarContrasena('u9', 'una-clave-larga')
    nadieAvisado()
  })

  it('adminDeleteUser → baja', async () => {
    await adminDeleteUser('u9')
    expect(avisos.publicarSesionCerrada).toHaveBeenCalledWith(['u9'], 'baja')
  })
  it('adminDeleteUser que falla, o contra uno mismo → no avisa', async () => {
    db.user.delete.mockRejectedValue(new Error('fk'))
    await adminDeleteUser('u9')
    await adminDeleteUser(ADMIN.id)
    nadieAvisado()
  })
})

/** Lo que devuelve Prisma para un rol con estas llaves. */
const conLlaves = (...llaves: string[]) => ({
  id: 'x', name: 'X', permissions: llaves.map((key) => ({ permission: { key } })),
})

/**
 * REGLA (auditoría 08/10/2026): `permisos-cambiados` sólo se publica cuando alguien PIERDE acceso.
 * Dar acceso —alta, un rol o una llave que se añaden— no publica nada, porque si no quien puede dar
 * de alta puede echar de todas las aplicaciones a quien quiera.
 */
describe('permisos-cambiados: sólo cuando se PIERDE acceso', () => {
  it('toggleUserAdmin QUITANDO el mando → admin', async () => {
    await toggleUserAdmin('u9', false)
    expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u9'], 'admin')
    expect(avisos.publicarSesionCerrada).not.toHaveBeenCalled()
  })
  it('toggleUserAdmin DANDO el mando → no avisa (sólo gana)', async () => {
    await toggleUserAdmin('u9', true)
    expect(db.user.update).toHaveBeenCalled()
    nadieAvisado()
  })
  it('toggleUserAdmin que falla → no avisa', async () => {
    db.user.update.mockRejectedValue(new Error('db'))
    await toggleUserAdmin('u9', false)
    nadieAvisado()
  })

  describe('cambiarRol', () => {
    const hay = (previo: unknown, nuevo: ReturnType<typeof conLlaves>) => {
      db.user.findUnique.mockResolvedValue(previo)
      db.role.findUnique.mockResolvedValue(nuevo)
    }
    it('a un rol con MENOS llaves → rol', async () => {
      hay({ isSystemAdmin: false, defaultRole: conLlaves('a', 'b') }, conLlaves('a'))
      expect((await cambiarRol('u9', 'r1')).error).toBeUndefined()
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u9'], 'rol')
    })
    it('a un rol que SÓLO añade llaves → no avisa', async () => {
      hay({ isSystemAdmin: false, defaultRole: conLlaves('a') }, conLlaves('a', 'b'))
      await cambiarRol('u9', 'r1')
      expect(db.user.update).toHaveBeenCalled()
      nadieAvisado()
    })
    it('a un rol con las mismas llaves, o el mismo rol → no avisa', async () => {
      hay({ isSystemAdmin: false, defaultRole: conLlaves('a', 'b') }, conLlaves('b', 'a'))
      await cambiarRol('u9', 'r1')
      nadieAvisado()
    })
    it('quien no tenía rol → no avisa (sólo gana)', async () => {
      hay({ isSystemAdmin: false, defaultRole: null }, conLlaves('a'))
      await cambiarRol('u9', 'r1')
      nadieAvisado()
    })
    it('un Super Admin degradado a un rol normal → rol, aunque el rol nuevo lleve todas las llaves', async () => {
      hay({ isSystemAdmin: true, defaultRole: conLlaves('a') }, conLlaves('a', 'b'))
      await cambiarRol('u9', 'r1')
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u9'], 'rol')
    })
    it('un rol que lo hace Super Admin y antes no lo era → no avisa', async () => {
      alta.esSuperAdmin.mockReturnValue(true)
      hay({ isSystemAdmin: false, defaultRole: conLlaves('a') }, conLlaves('a'))
      await cambiarRol('u9', 'r1')
      nadieAvisado()
    })
    it('con rol inexistente o con fallo → no avisa', async () => {
      db.role.findUnique.mockResolvedValueOnce(null)
      await cambiarRol('u9', 'nada')
      hay({ isSystemAdmin: false, defaultRole: conLlaves('a', 'b') }, conLlaves('a'))
      db.user.update.mockRejectedValue(new Error('db'))
      await cambiarRol('u9', 'r1')
      nadieAvisado()
    })
  })

  describe('restablecerPermisosDelRol', () => {
    beforeEach(() => db.role.findUnique.mockResolvedValue({ id: 'r1', name: 'GESTOR' }))
    const fabrica = (...llaves: string[]) => db.permission.findMany.mockResolvedValue(llaves.map((key, i) => ({ id: `p${i}`, key })))
    const tenia = (...llaves: string[]) => db.rolePermission.findMany.mockResolvedValue(llaves.map((key) => ({ permission: { key } })))

    it('si le QUITA alguna llave → llaves, a TODOS los que tienen el rol', async () => {
      tenia('a', 'b', 'extra'); fabrica('a', 'b')
      await restablecerPermisosDelRol('r1')
      expect(avisos.personasConRol).toHaveBeenCalledWith('r1')
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['p1', 'p2'], 'llaves')
    })
    it('si sólo le REPONE llaves → no avisa', async () => {
      tenia('a'); fabrica('a', 'b')
      const res = await restablecerPermisosDelRol('r1')
      expect(res.permisos).toBe(2)
      nadieAvisado()
    })
    it('que falla → no avisa', async () => {
      tenia('a', 'x'); fabrica('a')
      db.$transaction.mockRejectedValueOnce(new Error('db'))
      await restablecerPermisosDelRol('r1')
      nadieAvisado()
    })
  })

  it('removeOrgMember → membresia, de la persona del miembro', async () => {
    await removeOrgMember('m1')
    expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u-miembro'], 'membresia')
  })
  it('removeOrgMember que falla → no avisa', async () => {
    db.member.delete.mockRejectedValue(new Error('db'))
    await removeOrgMember('m1')
    nadieAvisado()
  })

  describe('setOrgMemberRoles', () => {
    const dosRoles = [{ ...rol }, { id: 'r2', name: 'OPERADOR', permissions: [] }]
    it('QUITANDO un rol → rol, de la persona del miembro', async () => {
      await setOrgMemberRoles('m1', ['r1']) // tenía `vieja`, se queda con r1
      expect(db.memberRole.deleteMany).toHaveBeenCalled()
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['u-miembro'], 'rol')
    })
    it('sólo AÑADIENDO roles → no avisa', async () => {
      db.memberRole.findMany.mockResolvedValue([{ roleId: 'r1' }])
      db.role.findMany.mockResolvedValue(dosRoles)
      await setOrgMemberRoles('m1', ['r1', 'r2'])
      expect(db.memberRole.create).toHaveBeenCalled()
      nadieAvisado()
    })
    it('sin cambios → no avisa', async () => {
      db.memberRole.findMany.mockResolvedValue([{ roleId: 'r1' }])
      await setOrgMemberRoles('m1', ['r1'])
      nadieAvisado()
    })
    it('que falla → no avisa', async () => {
      db.$transaction.mockRejectedValueOnce(new Error('db'))
      await setOrgMemberRoles('m1', ['r1'])
      nadieAvisado()
    })
  })

  describe('las ALTAS nunca publican', () => {
    it('agregarMiembro (membresía nueva) → crea y no avisa', async () => {
      const res = await agregarMiembro({ organizationId: 'org1', userId: 'u9', roleId: 'r1' })
      expect(res.error).toBeUndefined()
      expect(db.member.create).toHaveBeenCalled()
      nadieAvisado()
    })
    it('agregarMiembro (ya estaba, sólo se le añade el rol) → no avisa', async () => {
      db.member.findFirst.mockResolvedValue({ id: 'm-ya' })
      const res = await agregarMiembro({ organizationId: 'org1', userId: 'u9', roleId: 'r1' })
      expect(res.yaEstaba).toBe(true)
      expect(db.memberRole.upsert).toHaveBeenCalled()
      nadieAvisado()
    })
    it('anadirPersona → da de alta y no avisa', async () => {
      const res = await anadirPersona({ organizationId: 'org1', nombre: 'Ana', password: 'una-clave-larga', roleId: 'r1' })
      expect(res.error).toBeUndefined()
      expect(alta.altaPersona).toHaveBeenCalled()
      nadieAvisado()
    })
    it('anadirPersona sobre una cuenta que YA existía → tampoco avisa', async () => {
      alta.altaPersona.mockResolvedValue({ userId: 'u-viejo', memberId: 'm', yaExistia: true })
      await anadirPersona({ organizationId: 'org1', nombre: 'Ana', password: 'una-clave-larga', roleId: 'r1' })
      nadieAvisado()
    })
  })

  describe('updateOrganizationAdmin: sólo si DE VERDAD cambia', () => {
    beforeEach(() => db.organization.findUnique.mockResolvedValue({ activa: true, codigo: 'CAM' }))

    it('guardar SIN cambios (el formulario manda siempre codigo y activa) → no avisa', async () => {
      await updateOrganizationAdmin('org1', { name: 'Camagüey', codigo: 'CAM', activa: true, telefono: '555' })
      expect(db.organization.update).toHaveBeenCalled()
      nadieAvisado()
    })
    it('el código llega en minúsculas pero es el mismo → no avisa', async () => {
      await updateOrganizationAdmin('org1', { codigo: ' cam ', activa: true })
      nadieAvisado()
    })
    it('DESACTIVAR → membresia de TODA la sucursal', async () => {
      await updateOrganizationAdmin('org1', { codigo: 'CAM', activa: false })
      expect(avisos.personasDeLaSucursal).toHaveBeenCalledWith('org1')
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['s1', 's2'], 'membresia')
    })
    it('CAMBIAR el código → membresia de toda la sucursal', async () => {
      await updateOrganizationAdmin('org1', { codigo: 'CMG', activa: true })
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['s1', 's2'], 'membresia')
    })
    it('quitar el código → avisa; ponerlo donde no había → también (cambia)', async () => {
      await updateOrganizationAdmin('org1', { codigo: null })
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledTimes(1)
      db.organization.findUnique.mockResolvedValue({ activa: true, codigo: null })
      await updateOrganizationAdmin('org1', { codigo: 'CAM' })
      expect(avisos.publicarPermisosCambiados).toHaveBeenCalledTimes(2)
    })
    it('REACTIVAR → no avisa (sólo gana acceso)', async () => {
      db.organization.findUnique.mockResolvedValue({ activa: false, codigo: 'CAM' })
      await updateOrganizationAdmin('org1', { codigo: 'CAM', activa: true })
      nadieAvisado()
    })
    it('sólo cambia el teléfono → no avisa', async () => {
      await updateOrganizationAdmin('org1', { telefono: '555' })
      nadieAvisado()
    })
    it('que falla → no avisa', async () => {
      db.organization.update.mockRejectedValue(new Error('db'))
      await updateOrganizationAdmin('org1', { activa: false })
      nadieAvisado()
    })
    it('una sucursal que no existe → no avisa', async () => {
      db.organization.findUnique.mockResolvedValue(null)
      db.organization.update.mockRejectedValue(new Error('P2025'))
      await updateOrganizationAdmin('nada', { activa: false })
      nadieAvisado()
    })
  })

  it('deleteOrganizationAdmin → membresia de quienes eran de ella (apuntados ANTES de borrar)', async () => {
    const orden: string[] = []
    avisos.personasDeLaSucursal.mockImplementation(async () => { orden.push('leer'); return ['s1', 's2'] })
    db.organization.delete.mockImplementation(async () => { orden.push('borrar') })
    avisos.publicarPermisosCambiados.mockImplementation(async () => { orden.push('avisar') })
    await deleteOrganizationAdmin('org1')
    expect(orden).toEqual(['leer', 'borrar', 'avisar'])
    expect(avisos.publicarPermisosCambiados).toHaveBeenCalledWith(['s1', 's2'], 'membresia')
  })
  it('deleteOrganizationAdmin: si no se puede saber quiénes eran (la base falla) ABORTA: no borra y devuelve el error', async () => {
    avisos.personasDeLaSucursal.mockRejectedValue(new Error('db'))
    expect((await deleteOrganizationAdmin('org1')).error).toBeTruthy()
    expect(avisos.personasDeLaSucursal).toHaveBeenCalledWith('org1', { lanzar: true })
    expect(db.organization.delete).not.toHaveBeenCalled()
    nadieAvisado()
  })
  it('deleteOrganizationAdmin que falla → no avisa', async () => {
    db.organization.delete.mockRejectedValue(new Error('db'))
    await deleteOrganizationAdmin('org1')
    nadieAvisado()
  })
})
