import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./prisma";
import { compare as bcryptCompare } from "bcryptjs";
import { hashPassword as hashPorDefecto, verifyPassword as verificarPorDefecto } from "better-auth/crypto";
import {
    notifyEmailVerification,
    notifyForgotPassword,
    notifyPasswordResetSuccess,
    notifyWelcome,
} from "./notifications";
import { uuidv7 } from './uuidv7';
import { cerrarSesionesAntes, cerrarSesionesDespues } from './hooks-de-sesion';
import { auditarInicioWeb } from './historial-de-inicios';
import { CLIENTE_DE_APARATOS } from './sesiones-de-la-persona';

const APP_NAME = process.env.APP_NAME ?? "QB Auth";
/**
 * El dominio de ESTE servicio. Convención del ecosistema: la URL propia de cada
 * microservicio se llama APP_URL; a los demás se les llama por su nombre
 * (QB_AUTH_URL, QB_BACKEND_URL, QB_BOOKING_URL, QB_PANEL_URL, QB_SITE_URL).
 *
 * Se pasa a betterAuth() como `baseURL` (abajo) en vez de dejar que la librería lea
 * BETTER_AUTH_URL por su cuenta: si no, harían falta DOS variables con el mismo valor.
 */
const APP_URL = process.env.APP_URL ?? "http://localhost:3500";
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL ?? `support@${process.env.ROOT_DOMAIN ?? "localhost"}`;
const LOGO_URL = process.env.NOTIFY_LOGO_URL;
const PRIMARY_COLOR = process.env.NOTIFY_PRIMARY_COLOR ?? "#4F46E5";
const EMAIL_VERIFICATION_EXPIRES_IN = 60 * 60; // 1 hour
const RESET_PASSWORD_EXPIRES_IN = 60 * 60; // 1 hour

/**
 * Which client app the user came in through, read from the `qb.flow_state` cookie
 * that /api/flow writes on an SSO entry. A direct login at qb-accounts has no
 * client app, so this returns undefined and session.clientId stays null — the
 * admin UI renders that as "Directo".
 */
const clientIdFromFlowCookie = (cookieHeader?: string | null): string | undefined => {
    if (!cookieHeader) return undefined;
    const raw = cookieHeader
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith('qb.flow_state='))
        ?.slice('qb.flow_state='.length);
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(decodeURIComponent(raw)) as { clientId?: unknown };
        // `qb.flow_state` va sin firmar: el cliente de los aparatos no se acepta de aquí, sólo lo escribe `/api/auth/token`.
        return typeof parsed.clientId === 'string' && parsed.clientId && parsed.clientId !== CLIENTE_DE_APARATOS
            ? parsed.clientId
            : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Client IP behind a proxy, for the "your password changed" security email.
 * Same header order as `advanced.ipAddress.ipAddressHeaders` below, so the email
 * and the stored session agree on which IP they report.
 */
const IP_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'] as const;

const clientIpFrom = (request?: Request): string | undefined => {
    if (!request) return undefined;
    for (const header of IP_HEADERS) {
        // x-forwarded-for is a comma-separated chain; the client is the first entry.
        const value = request.headers.get(header)?.split(',')[0]?.trim();
        if (value) return value;
    }
    return undefined;
};

export const auth = betterAuth({
    baseURL: APP_URL,
    database: prismaAdapter(prisma, {
        provider: "postgresql",
    }),
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: false, // Allow login, but show banner to verify
        /**
         * Comprobar la contraseña sabiendo leer los dos formatos.
         *
         * Las cuentas que vienen de PEDIDO y de delivery traen su contraseña
         * cifrada con bcrypt (`$2a$`, `$2b$`, `$2y$`); las que nacen aquí usan el
         * cifrado propio de better-auth. Traer a alguien a este sistema no puede
         * significar quitarle la contraseña que lleva años usando.
         *
         * No es mantener dos sistemas: es SABER LEER lo que ya existe. Lo que se
         * escribe es siempre lo nuestro —`hash` no cambia—, así que en cuanto
         * alguien cambie su contraseña, su cuenta pasa al formato de la casa
         * sola. El día que no quede ninguna bcrypt, esto se borra.
         */
        password: {
            hash: hashPorDefecto,
            verify: async ({ hash, password }) => {
                if (/^\$2[aby]\$/.test(hash)) return bcryptCompare(password, hash);
                return verificarPorDefecto({ hash, password });
            },
        },
        resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN,
        // Quien recupera una cuenta robada no puede dejar viva la sesión del atacante. El aviso a las
        // demás aplicaciones («revocada») sale de `hooks-de-sesion.ts` al terminar `/reset-password`.
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user, url }) => {
            // Don't await - fire and forget to not block the flow
            notifyForgotPassword({
                email: user.email,
                userId: user.id,
                userName: user.name,
                resetUrl: url,
                expirationSeconds: RESET_PASSWORD_EXPIRES_IN,
                appName: APP_NAME,
                supportEmail: SUPPORT_EMAIL,
                logoUrl: LOGO_URL,
                primaryColor: PRIMARY_COLOR,
            }).catch(() => {});
        },
        onPasswordReset: async ({ user }, request) => {
            notifyPasswordResetSuccess({
                email: user.email,
                userId: user.id,
                userName: user.name,
                appName: APP_NAME,
                loginUrl: APP_URL,
                // Always send something: the template shows the IP in a security
                // notice, and a missing required variable would reject the send.
                ipAddress: clientIpFrom(request) ?? "Unknown",
                supportEmail: SUPPORT_EMAIL,
                logoUrl: LOGO_URL,
                primaryColor: PRIMARY_COLOR,
            }).catch(() => {});
        },
    },
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID || '',
            clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
            // Update user info (name, image) on each sign-in
            overrideUserInfoOnSignIn: true,
        },
    },
    advanced: {
        // LOS IDS NUEVOS SON UUIDv7. Sólo los nuevos: no se reescribe nada.
        //
        // Hasta aquí los ponía better-auth —32 caracteres alfanuméricos al azar—
        // y el `@default(cuid())` del `schema.prisma` casi nunca llegaba a
        // aplicarse, porque el id venía ya puesto. En la base conviven desde el
        // primer día los dos formatos, 163 cuid de las semillas y alnum32 de
        // better-auth, y nunca ha roto nada: todas las columnas son `text` y
        // ningún otro proyecto valida su forma. Un tercer formato entra en el
        // mismo hueco, y cuanto antes entre, menos historia vieja queda.
        //
        // v7 y no el atajo `generateId: "uuid"`, que da **v4**: lo que se busca
        // aquí es que ORDENEN. La hora va dentro, así que el orden alfabético de
        // los ids es el orden en que se crearon — y eso es lo que hace falta
        // cuando el trabajo se hace sin señal en cuatro sitios a la vez y sube
        // después, que es de lo que va el reparto entero.
        //
        // Ver `src/lib/uuidv7.ts` para el porqué largo y las trampas.
        database: { generateId: () => uuidv7() },
        cookiePrefix: 'qb',
        useSecureCookies: process.env.NODE_ENV === 'production',
        // Without this, better-auth only reads `x-forwarded-for` and discards it
        // unless it parses as a bare IP — so behind Traefik (which also sets the
        // cleaner `x-real-ip`) session.ipAddress was stored as null.
        ipAddress: {
            ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],
        },
        crossSubDomainCookies: {
            enabled: true,
            domain: process.env.ROOT_DOMAIN || "localhost",
        },
    },
    experimental: { joins: true },
    // Cerrar sesión en Accesos se avisa a las demás aplicaciones (`docs/sesion-unica.md`).
    hooks: { before: cerrarSesionesAntes, after: cerrarSesionesDespues },
    plugins: [
        nextCookies(),
        // Las sucursales las crea un Super Admin con una acción de servidor (`crearSucursal`). Con el valor
        // por defecto, cualquier persona autenticada hacía `POST /api/auth/organization/create`, quedaba
        // `owner` de su propia organización y desde ahí podía tocar membresías ajenas (auditoría 08/10/2026).
        // Los demás endpoints del plugin los corta `[...all]/route.ts` (`lib/rutas-de-better-auth.ts`).
        organization({ allowUserToCreateOrganization: false }),
    ],
    emailVerification: {
        sendVerificationEmail: async ({ user, url }) => {
            notifyEmailVerification({
                email: user.email,
                userId: user.id,
                userName: user.name,
                verificationUrl: url,
                expirationSeconds: EMAIL_VERIFICATION_EXPIRES_IN,
                appName: APP_NAME,
                supportEmail: SUPPORT_EMAIL,
                logoUrl: LOGO_URL,
                primaryColor: PRIMARY_COLOR,
            }).catch(() => {});
        },
        afterEmailVerification: async (user) => {
            notifyWelcome({
                email: user.email,
                userId: user.id,
                userName: user.name,
                appName: APP_NAME,
                actionUrl: `${APP_URL}/profile`,
                actionLabel: "Go to your profile",
                supportEmail: SUPPORT_EMAIL,
                logoUrl: LOGO_URL,
                primaryColor: PRIMARY_COLOR,
            }).catch(() => {});
        },
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: EMAIL_VERIFICATION_EXPIRES_IN,
    },
    databaseHooks: {
        session: {
            create: {
                /**
                 * Anotar de dónde salió la sesión: aplicación, IP y navegador.
                 *
                 * Esto es media auditoría. Cuando alguien dice "yo no completé
                 * ese pedido" o "a mí me sacó del sistema", lo primero que hace
                 * falta es desde dónde se entró — y la sesión es el único sitio
                 * donde eso consta.
                 *
                 * better-auth trae su propia captura de IP y navegador, pero en
                 * este despliegue las guardaba VACÍAS (cadena vacía, no null),
                 * así que la columna existía y no decía nada. Se rellenan aquí,
                 * que es donde tenemos las cabeceras a mano, y solo cuando
                 * vienen en blanco: si better-auth acertó, se respeta.
                 */
                before: async (session, ctx) => {
                    // Una cuenta de baja (`activo=false`) no abre sesión. Va ANTES de todo y con el mismo error que
                    // una contraseña mala: este hook corre cuando la clave ya es buena, y otro mensaje lo confirmaría.
                    const persona = await prisma.user.findUnique({ where: { id: session.userId }, select: { activo: true } });
                    if (persona?.activo === false) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password' });
                    if (!ctx) return;

                    const clientId = clientIdFromFlowCookie(ctx.headers?.get('cookie'));
                    const ip = clientIpFrom(ctx.request);
                    const agente = ctx.headers?.get('user-agent') ?? undefined;

                    const datos: Record<string, unknown> = {};
                    if (clientId) datos.clientId = clientId;
                    if (!session.ipAddress && ip) datos.ipAddress = ip;
                    if (!session.userAgent && agente) datos.userAgent = agente;

                    if (Object.keys(datos).length === 0) return;
                    return { data: { ...session, ...datos } };
                },
                /**
                 * Cada sesión que se abre deja huella para «Historial de inicios» de Mi
                 * cuenta (`lib/historial-de-inicios.ts`). Si apuntar falla, se entra igual.
                 */
                after: async (session) => auditarInicioWeb(session),
            },
        },
        user: {
            create: {
                after: async (user) => {
                    // La PRIMERA cuenta de una instalación vacía queda como Super
                    // Admin. Si no, se llega a un punto muerto: nadie puede entrar
                    // al panel porque no hay ningún administrador, y crear el
                    // primero exige entrar al panel. Se resolvía a mano con un
                    // UPDATE en la base, que es un paso que se olvida y que hay
                    // que recordar cada vez que se levanta un entorno nuevo.
                    //
                    // Solo cuando NO hay ninguna otra cuenta: en cuanto existe una
                    // persona, esta condición no se vuelve a cumplir nunca, así que
                    // no es una puerta abierta sino el arranque.
                    try {
                        const cuantos = await prisma.user.count();
                        if (cuantos === 1) {
                            await prisma.user.update({
                                where: { id: user.id },
                                data: { isSystemAdmin: true },
                            });
                        }
                    } catch {
                        // Que no reviente el alta: sin esto se queda sin Super
                        // Admin, pero con la cuenta creada y arreglable a mano.
                    }

                    // Send welcome email for social login users (already verified)
                    // Fire and forget - don't block auth flow if notification fails
                    if (user.emailVerified) {
                        notifyWelcome({
                            email: user.email,
                            userId: user.id,
                            userName: user.name,
                            appName: APP_NAME,
                            actionUrl: `${APP_URL}/profile`,
                            actionLabel: "Go to your profile",
                            supportEmail: SUPPORT_EMAIL,
                            logoUrl: LOGO_URL,
                            primaryColor: PRIMARY_COLOR,
                        }).catch(() => {
                            // Silently ignore notification errors
                        });
                    }
                },
            },
        },
    },
    account: {
        accountLinking: {
            enabled: true,
            // Update user profile (name, image) when linking a social account
            updateUserInfoOnLink: true,
        },
    },
    user: {
        additionalFields: {
            // EL REGISTRO PÚBLICO NO PUEDE FABRICAR UN SUPER ADMIN — 08/10/2026 (auditoría
            // de seguridad). Sin `input: false`, `POST /api/auth/sign-up/email` con
            // `isSystemAdmin: true` en el cuerpo guardaba la cuenta ya como administradora
            // del sistema (comprobado con better-auth y un adaptador en memoria), y ese
            // flag da el comodín en todas las aplicaciones. Con `input: false` el valor
            // del cuerpo se ignora y vale el `defaultValue`. Quien lo marca de verdad lo
            // hace con Prisma directo (`alta-persona.ts`, el hook `user.create.after` de
            // arriba y el interruptor del panel de personas), que no pasa por `input`.
            isSystemAdmin: {
                type: "boolean",
                defaultValue: false,
                input: false,
            },
            phone: {
                type: "string",
                required: false,
            },
            // Nombre de usuario, para poder entrar sin correo. Va aquí porque
            // better-auth solo lee del usuario los campos que se le declaran.
            username: {
                type: "string",
                required: false,
            },
        },
    },
    session: {
        additionalFields: {
            clientId: {
                type: "string",
                required: false,
            },
            revokedAt: {
                type: "date",
                required: false,
            },
        },
        cookieCache: {
            enabled: true,
            // 60 s y no 1 h: una sesión cerrada (otro navegador, «Cerrar sesión» de Mi cuenta) seguía valiendo en las
            // llamadas por HTTP hasta que caducara esta caché. Las del servidor miran la base siempre (hooks-de-sesion.ts).
            maxAge: 60,
        },
    },
});
