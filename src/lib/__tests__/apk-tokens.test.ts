/**
 * Las reglas de la puerta por token, una a una.
 *
 * Lo que se prueba aquí no es "que devuelva algo": es que un refresh usado dos
 * veces cierre la cuenta entera, que el par salga NUEVO cada vez, y que el token
 * lleve dentro la sucursal y los roles con los nombres que la API del reparto
 * lee. Las tres cosas fallan en silencio si nadie las mira: un par que repite
 * tokens y una revocación a medias tienen exactamente el mismo aspecto desde
 * fuera que los buenos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { decodeJwt } from 'jose'

// El secreto de firma se lee en cada llamada, así que basta con ponerlo antes de
// importar nada. 32 caracteres es el mínimo que exige `lib/jwt.ts`.
process.env.JWT_SECRET = 'un-secreto-de-pruebas-de-mas-de-32-caracteres'
process.env.APP_URL = 'https://auth.example.com'

// Sin base de datos: Prisma se sustituye entero, como en `role-resolver.test.ts`.
const db = vi.hoisted(() => ({
    user: { findUnique: vi.fn() },
    refreshToken: {
        create: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
    },
    session: { findUnique: vi.fn(), updateMany: vi.fn() },
}))
vi.mock('@/lib/prisma', () => ({ prisma: db }))
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }))
vi.mock('@/lib/logger', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
    ErrorDeIdentidad,
    SEGUNDOS_ACCESO,
    SEGUNDOS_DE_GRACIA,
    SEGUNDOS_REFRESH,
    cerrarSesionDelAparato,
    desdeDondePide,
    emitirPar,
    renovar,
    resolverIdentidad,
} from '../apk-tokens'
import { audit } from '@/lib/audit'

const mockUser = db.user.findUnique
const mockRefresh = db.refreshToken
const mockSession = db.session
const mockAudit = vi.mocked(audit)

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Una persona de Camagüey, Operadora, con su sucursal y su rol. */
function persona(extra: Record<string, unknown> = {}) {
    return {
        id: 'u1',
        name: 'Yasmani',
        email: 'Yasmani@Procovar.Local',
        username: 'yasmani',
        activo: true,
        isSystemAdmin: false,
        defaultRole: { name: 'OPERADOR' },
        members: [
            {
                organization: { codigo: 'CAM', activa: true },
                memberRoles: [{ role: { name: 'OPERADOR' } }],
            },
        ],
        ...extra,
    }
}

/** Un instante de hace N segundos. La gracia se mide con el reloj, así que casi
 *  todas las pruebas de abajo se escriben con esto. */
function hace(segundos: number): Date {
    return new Date(Date.now() - segundos * 1000)
}

/** Una fila de refresh viva, tal y como sale de la base. */
function fila(extra: Record<string, unknown> = {}) {
    return {
        id: 'rt1',
        userId: 'u1',
        sessionId: 's1',
        familyId: 'fam1',
        expiresAt: new Date(Date.now() + SEGUNDOS_REFRESH * 1000),
        usedAt: null,
        revokedAt: null,
        graceUsedAt: null,
        ...extra,
    }
}

/**
 * Una fila DE VERDAD en memoria, con un `updateMany` que respeta sus condiciones.
 *
 * Hace falta porque «la gracia se concede una vez» no se puede probar con un mock
 * que siempre contesta `{ count: 1 }`: ese mock dice que sí tanto si el `where`
 * lleva `graceUsedAt: null` como si no, o sea que no distingue el código bueno del
 * que quitó el candado. Aquí la condición se evalúa de verdad contra la fila.
 */
function baseConUnaFila(estado: Record<string, unknown>) {
    mockRefresh.findUnique.mockImplementation((async () => ({ ...estado })) as never)
    mockRefresh.updateMany.mockImplementation((async ({ where, data }: never) => {
        const w = where as Record<string, unknown>
        // Las revocaciones en bloque (por cuenta o por familia) no van contra esta
        // fila; se dejan pasar y se comprueban por separado con sus assertions.
        if (!w.id) return { count: 1 }
        const cumple = Object.entries(w).every(([k, v]) => estado[k] === v)
        if (!cumple) return { count: 0 }
        Object.assign(estado, data as Record<string, unknown>)
        return { count: 1 }
    }) as never)
}

beforeEach(() => {
    vi.resetAllMocks()
    // Por defecto: la persona existe, la sesión está viva y los escritos cuelan.
    mockUser.mockResolvedValue(persona() as never)
    mockSession.findUnique.mockResolvedValue({ revokedAt: null } as never)
    mockSession.updateMany.mockResolvedValue({ count: 1 } as never)
    mockRefresh.updateMany.mockResolvedValue({ count: 1 } as never)
    mockRefresh.update.mockResolvedValue({} as never)
    mockRefresh.findFirst.mockResolvedValue({ sessionId: 's1' } as never)
    let n = 0
    mockRefresh.create.mockImplementation((async () => ({ id: `nueva${++n}` })) as never)
})

describe('el token de acceso lleva la sucursal y los roles', () => {
    it('firma sub, sucursal y roles con los nombres que lee la API del reparto', async () => {
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        const c = decodeJwt(par.token)

        expect(c.sub).toBe('u1')
        // `sucursal` y `branch_id` son los dos nombres del token nuevo.
        expect(c.sucursal).toBe('CAM')
        expect(c.branch_id).toBe('CAM')
        expect(c.roles).toEqual(['OPERADOR'])
        expect(c.role).toBe('OPERADOR')
        expect(c.sid).toBe('s1')
    })

    it('NO usa `branchId`, que en la web significa otra cosa', async () => {
        // En la web `branchId` es el id de la sucursal dentro de la base de
        // delivery; aquí lo que se firma es el CÓDIGO (CAM, HAB…). Escribirlo con
        // ese nombre sería mandar una cosa con la etiqueta de la otra.
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        expect(Object.keys(decodeJwt(par.token))).not.toContain('branchId')
    })

    it('caduca a los 15 minutos', async () => {
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        const c = decodeJwt(par.token)
        const dura = (c.exp as number) - (c.iat as number)
        expect(dura).toBe(SEGUNDOS_ACCESO)
        expect(par.expires_in).toBe(SEGUNDOS_ACCESO)
    })

    it('va etiquetado, para que no cuele como otro token de la casa', async () => {
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        expect(decodeJwt(par.token).purpose).toBe('apk:access')
    })

    it('junta el rol de la persona con los de sus membresías, sin repetir', async () => {
        mockUser.mockResolvedValue(
            persona({
                defaultRole: { name: 'SUPERVISOR' },
                members: [
                    {
                        organization: { codigo: 'GR', activa: true },
                        memberRoles: [{ role: { name: 'SUPERVISOR' } }, { role: { name: 'GESTOR' } }],
                    },
                ],
            }) as never
        )
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        expect(decodeJwt(par.token).roles).toEqual(['SUPERVISOR', 'GESTOR'])
    })

    it('un LOGISTICO sale firmado como LOGISTICO, con su sucursal (08/10/2026)', async () => {
        // Es lo que lee la API del reparto para dejarlo entrar. No hay lista blanca de
        // roles en el camino: el nombre sale tal cual de la base. Si algún día la hay,
        // esto es lo que avisa.
        mockUser.mockResolvedValue(
            persona({
                defaultRole: { name: 'LOGISTICO' },
                members: [
                    {
                        organization: { codigo: 'HOL', activa: true },
                        memberRoles: [{ role: { name: 'LOGISTICO' } }],
                    },
                ],
            }) as never
        )
        const c = decodeJwt((await emitirPar({ userId: 'u1', sessionId: 's1' })).token)
        expect(c.role).toBe('LOGISTICO')
        expect(c.roles).toEqual(['LOGISTICO'])
        expect(c.sucursal).toBe('HOL')
        expect(c.branch_id).toBe('HOL')
        expect(c.sucursales).toEqual(['HOL'])
    })
})

describe('una cuenta isSystemAdmin firma SUPER ADMIN aunque no traiga rol (08/10/2026)', () => {
    // Hoy hay cuentas isSystemAdmin SIN rol por defecto ni membresía. Reparto decide por
    // el nombre del rol del token, y la web del reparto ya les añade SUPER ADMIN: por la
    // APK y el escritorio salían con `role: ''` y `roles: []` y se quedaban fuera.
    const sinRolNiMembresia = { isSystemAdmin: true, defaultRole: null, members: [] }

    it('sin rol ni membresía: role y roles dicen SUPER ADMIN', async () => {
        mockUser.mockResolvedValue(persona(sinRolNiMembresia) as never)
        const c = decodeJwt((await emitirPar({ userId: 'u1', sessionId: 's1' })).token)
        expect(c.role).toBe('SUPER ADMIN')
        expect(c.roles).toEqual(['SUPER ADMIN'])
        expect(c.sucursal).toBe('') // y sigue sin sucursal: ve las ocho
    })

    it('si ya lo trae no se repite', async () => {
        mockUser.mockResolvedValue(
            persona({
                ...sinRolNiMembresia,
                defaultRole: { name: 'SUPER ADMIN' },
                members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [{ role: { name: 'SUPER ADMIN' } }] }],
            }) as never
        )
        const id = await resolverIdentidad('u1')
        expect(id.role).toBe('SUPER ADMIN')
        expect(id.roles).toEqual(['SUPER ADMIN'])
    })

    it('con otro rol por defecto, éste sigue siendo el principal y SUPER ADMIN se suma', async () => {
        mockUser.mockResolvedValue(persona({ ...sinRolNiMembresia, defaultRole: { name: 'LOGISTICO' } }) as never)
        const id = await resolverIdentidad('u1')
        expect(id.role).toBe('LOGISTICO')
        expect(id.roles).toEqual(['LOGISTICO', 'SUPER ADMIN'])
    })

    it('quien NO es administrador del sistema no recibe SUPER ADMIN nunca', async () => {
        // Entra con una membresía sin roles: es el caso que pasa por la misma rama.
        mockUser.mockResolvedValue(
            persona({
                defaultRole: null,
                members: [{ organization: { codigo: 'CAM', activa: true }, memberRoles: [] }],
            }) as never
        )
        const id = await resolverIdentidad('u1')
        expect(id.role).toBeNull()
        expect(id.roles).toEqual([])
    })
})

describe('qué sucursal se firma', () => {
    it('el Super Admin la lleva vacía: es quien ve las ocho', async () => {
        mockUser.mockResolvedValue(persona({ isSystemAdmin: true, members: [] }) as never)
        const id = await resolverIdentidad('u1')
        expect(id.sucursal).toBe('')
    })

    it('quien está en varias y no pide ninguna se lleva la más antigua', async () => {
        mockUser.mockResolvedValue(
            persona({
                members: [
                    { organization: { codigo: 'CAM', activa: true }, memberRoles: [] },
                    { organization: { codigo: 'HOL', activa: true }, memberRoles: [] },
                ],
            }) as never
        )
        const id = await resolverIdentidad('u1')
        expect(id.sucursal).toBe('CAM')
        expect(id.sucursales).toEqual(['CAM', 'HOL'])
    })

    it('respeta la sucursal pedida cuando es suya', async () => {
        mockUser.mockResolvedValue(
            persona({
                members: [
                    { organization: { codigo: 'CAM', activa: true }, memberRoles: [] },
                    { organization: { codigo: 'HOL', activa: true }, memberRoles: [] },
                ],
            }) as never
        )
        expect((await resolverIdentidad('u1', 'HOL')).sucursal).toBe('HOL')
    })

    it('no deja pedir una sucursal ajena', async () => {
        await expect(resolverIdentidad('u1', 'STG')).rejects.toMatchObject({ motivo: 'sin_sucursal' })
    })

    it('NO firma a quien no está en ninguna sucursal y no es Super Admin', async () => {
        // Es la parte que más importa de todo este bloque: para la API del reparto
        // un token SIN sucursal no está limitado, está abierto a las ocho. Un
        // fallo aquí no se ve —sale un 200 con más pedidos de la cuenta— y enseña
        // la operación entera a quien no debería ver ni una.
        mockUser.mockResolvedValue(persona({ members: [] }) as never)
        await expect(resolverIdentidad('u1')).rejects.toMatchObject({ motivo: 'sin_sucursal' })
    })

    it('ignora las sucursales cerradas', async () => {
        mockUser.mockResolvedValue(
            persona({
                members: [
                    { organization: { codigo: 'CAM', activa: false }, memberRoles: [] },
                    { organization: { codigo: 'HOL', activa: true }, memberRoles: [] },
                ],
            }) as never
        )
        expect((await resolverIdentidad('u1')).sucursal).toBe('HOL')
    })

    it('a quien está dado de baja no se le firma nada', async () => {
        mockUser.mockResolvedValue(persona({ activo: false }) as never)
        await expect(resolverIdentidad('u1')).rejects.toBeInstanceOf(ErrorDeIdentidad)
    })
})

describe('el refresh que se guarda', () => {
    it('en la base va el sha256, nunca el token', async () => {
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        const guardado = mockRefresh.create.mock.calls[0][0].data

        expect(guardado.tokenHash).toBe(sha256(par.refresh_token))
        expect(JSON.stringify(guardado)).not.toContain(par.refresh_token)
    })

    it('dura 30 días', async () => {
        const par = await emitirPar({ userId: 'u1', sessionId: 's1' })
        expect(par.refresh_expires_in).toBe(SEGUNDOS_REFRESH)
    })

    it('un acceso nuevo abre una cadena nueva; una renovación hereda la suya', async () => {
        await emitirPar({ userId: 'u1', sessionId: 's1' })
        await emitirPar({ userId: 'u1', sessionId: 's1' })
        const a = mockRefresh.create.mock.calls[0][0].data.familyId
        const b = mockRefresh.create.mock.calls[1][0].data.familyId
        expect(a).not.toBe(b)

        await emitirPar({ userId: 'u1', sessionId: 's1', familyId: 'fam1' })
        expect(mockRefresh.create.mock.calls[2][0].data.familyId).toBe('fam1')
    })
})

describe('renovar devuelve un par NUEVO y gasta el viejo', () => {
    it('los dos tokens cambian, no sólo el de acceso', async () => {
        const primero = await emitirPar({ userId: 'u1', sessionId: 's1' })
        mockRefresh.findUnique.mockResolvedValue(fila() as never)

        const salida = await renovar(primero.refresh_token)

        expect(salida.ok).toBe(true)
        if (!salida.ok) return
        expect(salida.par.refresh_token).not.toBe(primero.refresh_token)
        expect(salida.par.token).not.toBe(primero.token)
    })

    it('marca el viejo como gastado antes de emitir', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila() as never)
        await renovar('lo-que-sea')

        // El gasto va condicionado a que siga limpio: es lo único que impide que
        // dos renovaciones a la vez con el mismo token salgan las dos adelante.
        const [args] = mockRefresh.updateMany.mock.calls[0]
        expect(args.where).toMatchObject({ id: 'rt1', usedAt: null, revokedAt: null })
        expect(args.data.usedAt).toBeInstanceOf(Date)
    })

    it('deja escrito cuál sustituyó a cuál', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila() as never)
        await renovar('lo-que-sea')
        expect(mockRefresh.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'rt1' }, data: { replacedBy: 'nueva1' } })
        )
    })

    it('estira la sesión, para que no se muera antes que el refresh', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila() as never)
        await renovar('lo-que-sea')

        const estirada = mockSession.updateMany.mock.calls.find(
            ([a]) => (a.data as { expiresAt?: Date }).expiresAt
        )
        expect(estirada).toBeDefined()
    })
})

describe('un refresh reutilizado es un robo', () => {
    it('cierra TODAS las sesiones de la cuenta, no sólo ese aparato', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: new Date('2026-09-01') }) as never)

        const salida = await renovar('el-viejo')

        expect(salida).toEqual({ ok: false, motivo: 'reuse' })
        // Las dos cosas: los refresh Y las sesiones de better-auth. Revocar sólo
        // una mitad deja la otra puerta abierta.
        expect(mockRefresh.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
        expect(mockSession.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('no emite ningún par', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: new Date('2026-09-01') }) as never)
        await renovar('el-viejo')
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('queda en la auditoría con nombre propio', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: new Date('2026-09-01') }) as never)
        await renovar('el-viejo')
        expect(mockAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse', userId: 'u1' })
        )
    })

    it('dos a la vez, pero la fila la gastó otro hace rato: robo', async () => {
        // Las dos leen la fila limpia y sólo una consigue gastarla. Si al volver a
        // mirarla resulta que el gasto es viejo —o que no hay gasto ninguno, que es
        // una fila que se movió por debajo—, no hay reintento que valga.
        mockRefresh.findUnique
            .mockResolvedValueOnce(fila() as never)
            .mockResolvedValueOnce({ usedAt: hace(SEGUNDOS_DE_GRACIA + 5), revokedAt: null } as never)
        mockRefresh.updateMany.mockResolvedValueOnce({ count: 0 } as never)

        const salida = await renovar('el-mismo')

        expect(salida).toEqual({ ok: false, motivo: 'reuse' })
        expect(mockSession.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })
})

/**
 * LA VENTANA DE GRACIA, que es lo que separa «se perdió la respuesta» de «me
 * robaron el token». Sin ella, la conexión de allá echa a la gente sola: el
 * 22/09/2026 sacó a Jose de la APK dos veces en veinte minutos, en mitad de una
 * descarga, y las dos con el registro diciendo «refresh reutilizado».
 *
 * Las pruebas van en pareja a propósito: una que la gracia se conceda cuando
 * toca, y otra que NO se conceda cuando no. Una gracia que no caduca nunca es
 * quitar la regla 3 sin decirlo.
 */
describe('la ventana de gracia', () => {
    it('un refresh que vuelve a los diez segundos NO cierra nada: se emite par', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(10) }) as never)

        const salida = await renovar('el-que-no-llego')

        expect(salida.ok).toBe(true)
        expect(mockRefresh.create).toHaveBeenCalled()
        // Y sobre todo: la cuenta sigue abierta.
        expect(mockSession.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('el par que sale es NUEVO, no el que se perdió', async () => {
        // El anterior aquí sólo existe como sha256: devolverlo es imposible. Lo que
        // no puede pasar es que la gracia devuelva algo que no sirva.
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(10) }) as never)

        const salida = await renovar('el-que-no-llego')

        expect(salida.ok && salida.par.refresh_token.length).toBeGreaterThan(20)
        expect(salida.ok && salida.par.expires_in).toBe(SEGUNDOS_ACCESO)
    })

    it('queda en la auditoría como gracia, NO como robo', async () => {
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(10) }) as never)
        await renovar('el-que-no-llego')

        expect(mockAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.gracia', userId: 'u1' })
        )
        expect(mockAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse' })
        )
    })

    it('la ventana son DOS MINUTOS, y el número está escrito aquí', async () => {
        // A propósito sin derivarlo de la constante. Todas las demás pruebas de
        // este bloque se escriben con `SEGUNDOS_DE_GRACIA`, así que ensanchar la
        // ventana a nueve minutos pasaba en verde: la constante no la sujetaba
        // nada. Ensancharla es una decisión de seguridad —cuanto más dura, más
        // tiempo vale un refresh robado— y tiene que costar tocar una prueba.
        expect(SEGUNDOS_DE_GRACIA).toBe(120)
    })

    it('a los 125 segundos ya es un robo (el número, no la constante)', async () => {
        // La pareja de la de arriba, y la que de verdad muerde: mide el
        // COMPORTAMIENTO con un número puesto a mano. Si alguien pone la ventana
        // en 540 s, 125 s cae dentro y esto se pone rojo.
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(125) }) as never)

        expect(await renovar('el-viejo')).toEqual({ ok: false, motivo: 'reuse' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('a los 115 segundos todavía es gracia (el número, no la constante)', async () => {
        // Y la otra mitad: que el número no se quede corto sin que nadie lo note.
        // Estrechar la ventana a 60 s devolvería las expulsiones del 22/09 y
        // ninguna prueba derivada de la constante lo vería.
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(115) }) as never)

        expect((await renovar('el-que-no-llego')).ok).toBe(true)
    })

    it('pasada la ventana vuelve a ser un robo', async () => {
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(SEGUNDOS_DE_GRACIA + 1) }) as never
        )

        expect(await renovar('el-viejo')).toEqual({ ok: false, motivo: 'reuse' })
        expect(mockSession.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('gastado Y revocado no tiene gracia: no se reabre por la puerta de atrás', async () => {
        // Revocado es que lo cerramos nosotros. Reabrirlo aquí dejaría que un
        // logout se deshiciera solo.
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(1), revokedAt: hace(1) }) as never
        )

        expect(await renovar('cerrado-y-gastado')).toEqual({ ok: false, motivo: 'revoked' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('...y `revoked` NO es `reuse`: un logout en carrera no cierra la cuenta', async () => {
        // La otra mitad de la pareja, y es la que importa. Un `revokedAt` lo
        // ponemos NOSOTROS. Tratarlo como robo hacía que cerrar sesión mientras
        // había una renovación en vuelo echara a la persona de TODOS sus aparatos
        // —justo el dolor que la ventana de gracia venía a quitar—.
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(1), revokedAt: hace(1) }) as never
        )

        await renovar('cerrado-y-gastado')

        expect(mockSession.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
        expect(mockRefresh.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
        expect(mockAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse' })
        )
    })

    it('un logout que gana la carrera a la renovación tampoco cierra la cuenta', async () => {
        // El mismo caso por el otro camino: las dos peticiones leyeron la fila
        // limpia, el gasto no cuela porque entre medias entró el logout. Quitar
        // esta comprobación manda el logout a la rama de robo y revoca la cuenta.
        mockRefresh.findUnique
            .mockResolvedValueOnce(fila() as never)
            .mockResolvedValueOnce({ usedAt: null, revokedAt: hace(1) } as never)
        mockRefresh.updateMany.mockResolvedValueOnce({ count: 0 } as never)

        expect(await renovar('el-mismo')).toEqual({ ok: false, motivo: 'revoked' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
        expect(mockSession.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('un logout en carrera CON la fila ya gastada tampoco es robo', async () => {
        // Variante: la fila se gastó y además la revocaron. Antes bastaba con
        // quitar `otraVez?.revokedAt ||` de la condición para que esto siguiera
        // pasando en verde; ahora `revoked` es una salida propia y se mira.
        mockRefresh.findUnique
            .mockResolvedValueOnce(fila() as never)
            .mockResolvedValueOnce({ usedAt: hace(1), revokedAt: hace(1) } as never)
        mockRefresh.updateMany.mockResolvedValueOnce({ count: 0 } as never)

        expect(await renovar('el-mismo')).toEqual({ ok: false, motivo: 'revoked' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
        expect(mockAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse' })
        )
    })

    it('un reloj que va hacia atrás no abre la puerta', async () => {
        // Un `usedAt` en el futuro da una diferencia negativa. Con un `<=` a secas
        // eso entra en la ventana, y la gracia se convierte en barra libre.
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: new Date(Date.now() + 60_000) }) as never
        )

        expect(await renovar('del-futuro')).toEqual({ ok: false, motivo: 'reuse' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('dos peticiones a la vez del mismo aparato: la que pierde también entra', async () => {
        // Es el caso de la cola que sale de golpe al recuperar señal. Antes las dos
        // salían por «robo» y la cuenta entera se cerraba.
        mockRefresh.findUnique
            .mockResolvedValueOnce(fila() as never)
            .mockResolvedValueOnce({ usedAt: new Date(), revokedAt: null } as never)
        mockRefresh.updateMany.mockResolvedValueOnce({ count: 0 } as never)

        const salida = await renovar('el-mismo')

        expect(salida.ok).toBe(true)
        expect(mockSession.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })
})

/**
 * LA GRACIA SE CONCEDE UNA VEZ POR FILA, que es la regla 4 y el agujero que abrió
 * la primera versión de la ventana.
 *
 * Sin tope, la misma fila gastada se canjeaba una vez por intento: cinco llamadas,
 * cinco pares válidos, cinco ramas de 30 días. Y como la reutilización se detecta
 * porque una fila vuelve, tener ramas paralelas es tener la detección de esa cuenta
 * apagada un mes. Cerraba de menos donde antes cerraba de más.
 *
 * El tope es `graceUsedAt`, reclamado con un `updateMany` condicionado a que esté a
 * null. Por eso estas pruebas usan `baseConUnaFila`: con un `updateMany` que
 * siempre dice `{ count: 1 }` no hay forma de ver la diferencia entre el candado y
 * su ausencia.
 */
describe('la gracia se concede UNA sola vez por fila', () => {
    it('el primer reintento saca par; el segundo ya no', async () => {
        const estado = fila({ usedAt: hace(10) })
        baseConUnaFila(estado)

        const primera = await renovar('el-que-no-llego')
        const segunda = await renovar('el-que-no-llego')

        expect(primera.ok).toBe(true)
        expect(segunda).toEqual({ ok: false, motivo: 'gracia_gastada' })
        // UN par emitido, no dos. Esto es el agujero medido: dos pares = dos ramas.
        expect(mockRefresh.create).toHaveBeenCalledTimes(1)
    })

    it('cinco llamadas con el refresh robado sacan UN par, no cinco', async () => {
        // El ataque tal cual lo describió la auditoría.
        const estado = fila({ usedAt: hace(10) })
        baseConUnaFila(estado)

        const salidas = []
        for (let i = 0; i < 5; i++) salidas.push(await renovar('el-robado'))

        expect(salidas.filter((r) => r.ok)).toHaveLength(1)
        expect(mockRefresh.create).toHaveBeenCalledTimes(1)
    })

    it('la gracia se reclama contra la base, condicionada a que no se haya usado', async () => {
        // La forma del candado, no sólo su efecto: sin `graceUsedAt: null` en el
        // `where`, el `updateMany` dice que sí siempre y el tope desaparece.
        mockRefresh.findUnique.mockResolvedValue(fila({ usedAt: hace(10) }) as never)

        await renovar('el-que-no-llego')

        const reclamo = mockRefresh.updateMany.mock.calls.find(
            ([a]) => (a.data as { graceUsedAt?: Date }).graceUsedAt
        )
        expect(reclamo).toBeDefined()
        expect(reclamo![0].where).toMatchObject({ id: 'rt1', graceUsedAt: null })
    })

    it('quedarse sin gracia NO cierra la cuenta: es una red mala insistiendo', async () => {
        // Quien vuelve una TERCERA vez con el mismo refresh es casi siempre un
        // aparato que perdió dos respuestas seguidas: el ladrón ya recibió su par
        // en la primera y no tiene por qué insistir con el viejo. Así que aquí se
        // queda fuera ese aparato y nadie más. Revocar la cuenta sería castigar
        // otra vez exactamente lo que el 22/09 costó el día.
        const estado = fila({ usedAt: hace(10) })
        baseConUnaFila(estado)

        await renovar('el-que-no-llego')
        vi.mocked(mockSession.updateMany).mockClear()
        mockAudit.mockClear()

        const segunda = await renovar('el-que-no-llego')

        expect(segunda).toEqual({ ok: false, motivo: 'gracia_gastada' })
        expect(mockSession.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
        expect(mockAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse' })
        )
        // Pero queda dicho, que si no esto no se puede contar después.
        expect(mockAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.gracia_agotada', userId: 'u1' })
        )
    })

    it('pasada la ventana sigue siendo la regla 3, gracia gastada o no', async () => {
        // El tope no ablanda la regla 3: un refresh que vuelve TARDE cierra la
        // cuenta entera aunque su gracia ya estuviera gastada.
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(300), graceUsedAt: hace(290) }) as never
        )

        expect(await renovar('el-robado-de-verdad')).toEqual({ ok: false, motivo: 'reuse' })
        expect(mockSession.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('una renovación normal no gasta la gracia de la fila nueva', async () => {
        // La gracia es del reintento, no de la rotación: gastarla en el camino
        // bueno dejaría al primer reintento legítimo sin ella.
        mockRefresh.findUnique.mockResolvedValue(fila() as never)

        await renovar('el-que-toca')

        expect(mockRefresh.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ graceUsedAt: expect.anything() }) })
        )
    })
})

/**
 * LA GRACIA NO SE ATA AL APARATO, y es una decisión, no un olvido.
 *
 * `clientId` y `userAgent` los escribe el cliente: quien copió el refresh copió la
 * petición entera, así que exigirlos no es una comprobación sino un adorno que se
 * lee como defensa. Y la IP, que sí costaría falsificar, rompe justo el caso que
 * esto existe para tolerar: el reintento llega de otra celda, de otro NAT de
 * carrier o del salto a Starlink. Lo que se hace es ANOTARLO.
 */
describe('la gracia no mira de dónde viene, pero lo deja escrito', () => {
    it('un reintento desde otra IP y otro userAgent sigue teniendo gracia', async () => {
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(10), ip: '1.1.1.1', userAgent: 'reparto/1.0' }) as never
        )

        const salida = await renovar('el-que-no-llego', {
            clientId: 'delivery-apk',
            ip: '2.2.2.2',
            userAgent: 'reparto/1.1',
        })

        expect(salida.ok).toBe(true)
    })

    it('la auditoría deja dicho si el cliente coincide', async () => {
        mockRefresh.findUnique.mockResolvedValue(
            fila({ usedAt: hace(10), clientId: 'delivery-apk' }) as never
        )

        await renovar('el-que-no-llego', { clientId: 'otra-cosa', ip: '2.2.2.2' })

        expect(mockAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'auth.refresh.gracia',
                ip: '2.2.2.2',
                meta: expect.objectContaining({ mismoCliente: false }),
            })
        )
    })
})

describe('lo que NO es un robo', () => {
    it('un token que no existe no revoca nada', async () => {
        // No dice de quién es, así que no hay cuenta que cerrar. Tratarlo como robo
        // dejaría a cualquiera cerrar sesiones ajenas mandando tokens inventados.
        mockRefresh.findUnique.mockResolvedValue(null as never)

        expect(await renovar('inventado')).toEqual({ ok: false, motivo: 'invalid' })
        expect(mockSession.updateMany).not.toHaveBeenCalled()
        expect(mockRefresh.updateMany).not.toHaveBeenCalled()
    })

    it('uno que revocamos nosotros no dispara la revocación en cadena', async () => {
        // Cerrar sesión y volver a intentarlo con el token viejo es torpe, no un
        // robo. Si contara como robo, cada logout con reintento cerraría la cuenta.
        mockRefresh.findUnique.mockResolvedValue(fila({ revokedAt: new Date('2026-09-01') }) as never)

        expect(await renovar('ya-cerrado')).toEqual({ ok: false, motivo: 'revoked' })
        expect(mockAudit).not.toHaveBeenCalledWith(
            expect.objectContaining({ action: 'auth.refresh.reuse' })
        )
    })

    it('uno caducado se cierra y ya', async () => {
        mockRefresh.findUnique.mockResolvedValue(
            fila({ expiresAt: new Date(Date.now() - 1000) }) as never
        )
        expect(await renovar('viejo')).toEqual({ ok: false, motivo: 'expired' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('si revocaron la sesión desde el panel, la APK se cae aquí', async () => {
        mockSession.findUnique.mockResolvedValue({ revokedAt: new Date('2026-09-01') } as never)
        mockRefresh.findUnique.mockResolvedValue(fila() as never)

        expect(await renovar('con-sesion-muerta')).toEqual({ ok: false, motivo: 'revoked' })
        expect(mockRefresh.create).not.toHaveBeenCalled()
    })

    it('si dieron de baja a la persona, tampoco renueva', async () => {
        mockUser.mockResolvedValue(persona({ activo: false }) as never)
        mockRefresh.findUnique.mockResolvedValue(fila() as never)

        expect(await renovar('de-un-despedido')).toEqual({ ok: false, motivo: 'revoked' })
    })
})

describe('cerrar sesión desde el aparato', () => {
    it('cierra su cadena y su sesión, y nada más', async () => {
        mockRefresh.findUnique.mockResolvedValue(
            { id: 'rt1', userId: 'u1', familyId: 'fam1' } as never
        )

        await cerrarSesionDelAparato('el-suyo')

        expect(mockRefresh.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { familyId: 'fam1', revokedAt: null } })
        )
        // Por cadena, NO por cuenta: quien cierra sesión en el teléfono no está
        // diciendo que le hayan robado nada, y echarle de paso la sesión web sería
        // una sorpresa desagradable.
        expect(mockRefresh.updateMany).not.toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 'u1', revokedAt: null } })
        )
    })

    it('un token desconocido no hace nada y no revienta', async () => {
        mockRefresh.findUnique.mockResolvedValue(null as never)
        await expect(cerrarSesionDelAparato('inventado')).resolves.toBeUndefined()
        expect(mockRefresh.updateMany).not.toHaveBeenCalled()
    })
})

describe('de dónde viene la petición', () => {
    it('lee las cabeceras en el mismo orden que lib/auth.ts', () => {
        const h = new Headers({
            'x-forwarded-for': '9.9.9.9, 10.0.0.1',
            'x-real-ip': '8.8.8.8',
            'cf-connecting-ip': '7.7.7.7',
            'user-agent': 'reparto/1.0',
        })
        expect(desdeDondePide(h)).toEqual({ ip: '7.7.7.7', userAgent: 'reparto/1.0' })
    })

    it('de la cadena de x-forwarded-for se queda con el primero', () => {
        const h = new Headers({ 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })
        expect(desdeDondePide(h).ip).toBe('9.9.9.9')
    })
})
