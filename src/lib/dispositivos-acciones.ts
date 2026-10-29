/**
 * LO QUE SE PUEDE HACER CON UN APARATO — la misma lógica para el panel de Accesos (`/api/admin/dispositivos/{id}`) y para la
 * aplicación dueña del aparato por la red interna (`/api/service/dispositivos/{aparatoId}/…`): que el CRM bloquee desde sus
 * pantallas tiene que hacer EXACTAMENTE lo que haría el administrador en Accesos (cerrar la cadena de refresh, auditar, avisar).
 */
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { cerrarFamilia } from '@/lib/apk-tokens';
import { limpiarTexto } from '@/lib/dispositivos';
import { avisarDeDispositivo, type MotivoDeDispositivo } from '@/lib/eventos-de-dispositivos';

export type OrdenDeDispositivo =
    | { accion: 'nombre'; nombre: string | null }
    | { accion: 'cerrar' }
    | { accion: 'bloquear' }
    | { accion: 'desbloquear' };

/** EL APARATO EN UNA APLICACIÓN (`dispositivo_app`): lo que se bloquea o se cierra. El nombre, en cambio, es del aparato entero. */
export interface FilaParaActuar {
    id: string;
    dispositivoId: string;
    clientId: string;
    aparatoId: string;
    userId: string;
    familyId: string | null;
    bloqueadoAt: Date | null;
}

/** Quién lo hace, para la auditoría: una persona desde el panel o una credencial de servicio desde su aplicación. */
export interface Actor {
    /** El id de la persona o el `clientId` de la credencial de servicio. */
    id: string;
    via: 'panel' | 'servicio';
}

export type Resultado = { ok: true } | { ok: false; estado: 409; error: 'sin_sesion_que_cerrar' };

/**
 * Hace la acción, la audita y AVISA a la aplicación dueña. Si el aviso falla, la acción YA está hecha (`avisarDeDispositivo` no
 * lanza). `bloquear` deja el aparato bloqueado ANTES de cerrar su cadena: la renovación ya lo rechaza aunque el cierre falle.
 */
export async function aplicarOrden(
    fila: FilaParaActuar,
    orden: OrdenDeDispositivo,
    actor: Actor,
    aparato: { ip?: string | null; userAgent?: string | null }
): Promise<Resultado> {
    let motivo: MotivoDeDispositivo;
    let bloqueadoAt = fila.bloqueadoAt;

    switch (orden.accion) {
        case 'nombre': {
            // El nombre es del APARATO (lo comparten todas sus aplicaciones): se pisa en `dispositivo` y se sube el `updatedAt` de cada
            // aplicación para que su lista con `desde=` lo recoja. Cada una recibe su aviso.
            await prisma.dispositivo.update({ where: { id: fila.dispositivoId }, data: { nombre: limpiarTexto(orden.nombre, 80) } });
            await prisma.dispositivoApp.updateMany({ where: { dispositivoId: fila.dispositivoId }, data: { updatedAt: new Date() } });
            motivo = 'renombrado';
            break;
        }
        case 'cerrar': {
            // Sin cadena de refresh (el aparato nunca renovó con cabeceras) no hay nada que cerrar: se dice, no se inventa.
            if (!fila.familyId) return { ok: false, estado: 409, error: 'sin_sesion_que_cerrar' };
            await cerrarFamilia(fila.familyId);
            motivo = 'sesion-cerrada';
            break;
        }
        case 'bloquear': {
            bloqueadoAt = new Date();
            await prisma.dispositivoApp.update({ where: { id: fila.id }, data: { bloqueadoAt, bloqueadoPor: actor.id } });
            if (fila.familyId) await cerrarFamilia(fila.familyId);
            motivo = 'bloqueado';
            break;
        }
        case 'desbloquear': {
            bloqueadoAt = null;
            await prisma.dispositivoApp.update({ where: { id: fila.id }, data: { bloqueadoAt: null, bloqueadoPor: null } });
            motivo = 'desbloqueado';
            break;
        }
    }

    audit({
        action: `dispositivo.${orden.accion}`,
        // Solo una PERSONA va en `userId`: una credencial de servicio no es una fila de `user`.
        userId: actor.via === 'panel' ? actor.id : undefined,
        clientId: fila.clientId,
        resource: fila.aparatoId,
        ip: aparato.ip ?? null,
        userAgent: aparato.userAgent ?? null,
        meta: { dispositivoId: fila.dispositivoId, dispositivoAppId: fila.id, persona: fila.userId, via: actor.via, ...(actor.via === 'servicio' ? { servicio: actor.id } : {}) },
    });

    if (orden.accion === 'nombre') {
        const apps = await prisma.dispositivoApp.findMany({ where: { dispositivoId: fila.dispositivoId }, select: { clientId: true, bloqueadoAt: true } });
        for (const a of apps) await avisarDeDispositivo({ clientId: a.clientId, aparatoId: fila.aparatoId, bloqueadoAt: a.bloqueadoAt }, motivo);
    } else {
        await avisarDeDispositivo({ clientId: fila.clientId, aparatoId: fila.aparatoId, bloqueadoAt }, motivo);
    }
    return { ok: true };
}
