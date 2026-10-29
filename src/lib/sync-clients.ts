/**
 * Catálogo de aplicaciones que se autentican contra este servicio, y su
 * sincronización al arrancar.
 *
 * Antes vivía solo dentro de `prisma/seed.ts`, y eso obligaba a entrar al
 * servidor y correr el seed a mano cada vez que se añadía una aplicación — con
 * el resultado previsible: la aplicación desplegada devolvía 401 y nadie sabía
 * por qué. Ahora se sincroniza en el arranque, igual que ya hacía el RBAC
 * (`syncRbac` en `src/instrumentation.ts`).
 *
 * Es idempotente y NO borra: si alguien añadió un cliente desde la pantalla de
 * administración, un despliegue no se lo lleva por delante.
 *
 * La clave de firma de cada cliente NO se guarda: se deriva de
 * SERVICE_AUTH_SECRET con `deriveSigningKey(clientId, version)`, así que basta
 * con que el clientId coincida a los dos lados.
 */
import { prisma } from './prisma'

export interface ClienteRegistrado {
    clientId: string
    name: string
    description: string
    allowedCallbackUrls: string[]
    allowedDomains: string[]
    scopes: string[]
}

export const CLIENTES: ClienteRegistrado[] = [
    {
        clientId: 'procovar-rutas',
        name: 'Procovar Rutas',
        description: 'Panel de control de los recorridos GPS de los vendedores',
        allowedCallbackUrls: [
            'https://rutas.procovar.cloud/api/auth/callback',
            'http://localhost:3600/api/auth/callback',
        ],
        // El puerto forma parte del host: `localhost` no casa con `localhost:3600`.
        allowedDomains: ['rutas.procovar.cloud', 'localhost:3600', 'localhost:3601'],
        scopes: ['callback:create', 'session:verify', 'session:revoke', 'auth:exchange'],
    },
    {
        clientId: 'procovar-notify',
        name: 'Procovar Notify (Avisos)',
        description: 'Servicio de avisos: avisos.procovar.cloud (pantalla) y avisos-api.procovar.cloud (API). Valida aqui la cookie de sesion de quien entra a administrarlo.',
        // Sin login propio: la SPA de Avisos manda a la gente a este hub y
        // vuelve con la cookie; Avisos solo la VERIFICA.
        // La vuelta la atiende la API (avisos-api), no la pantalla: es el
        // backend quien canjea el codigo y graba la cookie. Poner aqui la URL
        // de la pantalla hace que el hub RECHACE la peticion y el usuario acabe
        // en /login?sso=no-disponible sin ninguna pista de por que.
        allowedCallbackUrls: [
            'https://avisos-api.procovar.cloud/admin/auth/sso/callback',
            'http://localhost:8080/admin/auth/sso/callback',
        ],
        allowedDomains: ['avisos.procovar.cloud', 'avisos-api.procovar.cloud', 'localhost:5173'],
        // Con `session:verify` basta: /api/auth/verify-session ya devuelve el
        // RBAC resuelto, asi que Avisos lee de ahi las claves avisos.* y decide.
        scopes: ['callback:create', 'session:verify', 'session:revoke', 'auth:exchange'],
    },
    {
        clientId: 'aft',
        name: 'AFT Camagüey',
        description: 'Inventario de activos fijos y de útiles y herramientas de la sucursal de Camagüey.',
        // La vuelta la atiende el BACKEND (Express), no la pantalla: es él quien canjea
        // el código y graba la cookie. Poner aquí la URL de la pantalla hace que el hub
        // rechace la petición y la persona acabe en /login?sso=no-disponible sin saber
        // por qué — ya pasó con Avisos.
        allowedCallbackUrls: [
            'https://aft.procovar.cloud/api/auth/sso/callback',
            'http://localhost:8080/api/auth/sso/callback',
        ],
        // El puerto forma parte del host: `localhost` no casa con `localhost:8080`.
        allowedDomains: ['aft.procovar.cloud', 'localhost:8080', 'localhost:5173'],
        scopes: ['callback:create', 'session:verify', 'session:revoke', 'auth:exchange'],
    },
    {
        clientId: 'asignacion',
        name: 'Asignación de vendedores',
        description: 'Reparto de productos entre vendedores y control de cobros (Camagüey).',
        allowedCallbackUrls: [
            'https://asignacion.procovar.cloud/api/auth/sso/callback',
            'http://localhost:4000/api/auth/sso/callback',
        ],
        allowedDomains: ['asignacion.procovar.cloud', 'localhost:4000', 'localhost:5173'],
        scopes: ['callback:create', 'session:verify', 'session:revoke', 'auth:exchange'],
    },
    {
        clientId: 'crm',
        name: 'CRM de fuerza de ventas',
        description: 'CRM de los vendedores en campo: API y web en crm.procovar.cloud. La APK entra con el token de APK (client_id crm-apk), no por aquí.',
        // La vuelta la atiende la API del CRM (mismo origen que la web): canjea el
        // código y graba la cookie. Se compara origen y ruta exactos.
        allowedCallbackUrls: [
            'https://crm.procovar.cloud/api/auth/callback',
            'http://localhost:8080/api/auth/callback',
        ],
        allowedDomains: ['crm.procovar.cloud', 'localhost:8080'],
        // `dispositivos:crm-apk`: puede leer y gestionar SOLO los aparatos de su APK (`/api/service/dispositivos`, docs/dispositivos.md).
        // Tiene que estar AQUÍ y no solo en la migración: `syncClients` reescribe los scopes en cada arranque (se perdió el 29/10/2026).
        scopes: ['callback:create', 'session:verify', 'session:revoke', 'auth:exchange', 'dispositivos:crm-apk'],
    },
    {
        clientId: 'procovar-sync',
        name: 'Procovar Sync',
        description: 'Servicio de sincronizacion de la fuerza de ventas: ingesta de Axis/Ventra, sync de las tablets Android y salidas a los sistemas externos.',
        // Solo servicio: las tablets se autentican contra la API de sync, no
        // redirigen aqui. Por eso no hay callbacks ni dominios.
        allowedCallbackUrls: [],
        allowedDomains: [],
        // apikey:verify -> valida la credencial de cada tablet.
        scopes: ['session:verify', 'session:revoke', 'apikey:verify', 'jwt:sign', 'jwt:verify'],
    },
]

export async function syncClients() {
    let creados = 0
    let actualizados = 0

    for (const c of CLIENTES) {
        const existente = await prisma.clientApp.findUnique({
            where: { clientId: c.clientId },
            select: { id: true },
        })

        if (!existente) {
            await prisma.clientApp.create({ data: c })
            creados++
            continue
        }

        // Solo las URLs y los ámbitos: el nombre y la descripción se pueden haber
        // cambiado desde la pantalla, y no es cosa del despliegue devolverlos a
        // lo que decía el código.
        await prisma.clientApp.update({
            where: { clientId: c.clientId },
            data: {
                allowedCallbackUrls: c.allowedCallbackUrls,
                allowedDomains: c.allowedDomains,
                scopes: c.scopes,
            },
        })
        actualizados++
    }

    return { creados, actualizados }
}
