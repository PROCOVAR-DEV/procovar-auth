/**
 * GET /api/auth/callback
 *
 * Hit after the user successfully authenticates. Reads the validated flow
 * cookie set by /api/flow, mints a single-use opaque auth code (Redis 60s)
 * containing the session token, and redirects the user to the original
 * callbackUrl with `?code=<auth_code>`.
 *
 * La puerta (`lib/puerta-de-entrada.ts`): sin la llave `<app>.entrar` NO se acuña el
 * código. La galleta de flujo es JSON sin firmar, así que antes de mirar la llave se
 * vuelve a validar (`validateCallbackPayload`, como hace `/api/flow` al crearla); si no
 * vale, a `/sin-permiso` sin código. Un sondeo silencioso (`prompt=none`) sin la llave
 * vuelve a la aplicación con `?sso=none` en vez de a la pantalla.
 */
import { NextResponse } from 'next/server';
import { cookies, headers as nextHeaders } from 'next/headers';
import type { FlowOptions } from '@/lib/flow-state';
import { getSessionCookieName, urlSsoNone } from '@/lib/flow-state';
import { CallbackValidationError, validateCallbackPayload } from '@/lib/callback-validator';
import { createAuthCode } from '@/lib/auth-code';
import { auth } from '@/lib/auth';
import { audit } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { puedeEntrar, urlSinPermiso } from '@/lib/puerta-de-entrada';

const DEFAULT_REDIRECT = '/profile';
const BASE_URL = process.env.APP_URL || 'http://localhost:3500';

/**
 * ¿El flujo de la galleta es uno que `/api/flow` habría dejado crear? `clientId` conocido y
 * activo, `origin` en la lista de direcciones de ese cliente y `returnTo` en sus dominios.
 * Cualquier fallo —también la base caída— es «no»: falla cerrado, sin acuñar código.
 */
async function flujoValido(flow: FlowOptions): Promise<boolean> {
    try {
        await validateCallbackPayload({
            clientId: flow.clientId ?? '',
            callbackUrl: flow.origin ?? '',
            returnTo: typeof flow.returnTo === 'string' ? flow.returnTo : undefined,
        });
        return true;
    } catch (e) {
        logger.warn('[auth/callback] flujo de la galleta rechazado', {
            code: e instanceof CallbackValidationError ? e.code : 'error',
        });
        return false;
    }
}

export async function GET() {
    const cookieStore = await cookies();
    const flowCookie = cookieStore.get('qb.flow_state');
    let redirectUrl = DEFAULT_REDIRECT;
    let isExternal = false;

    try {
        if (flowCookie?.value) {
            const flow: FlowOptions = JSON.parse(flowCookie.value);

            if (flow.redirectOrigin && flow.origin?.startsWith('http')) {
                const sessionCookieName = getSessionCookieName();
                const sessionCookie = cookieStore.get(sessionCookieName);
                if (!sessionCookie?.value) {
                    redirectUrl = flow.origin;
                    isExternal = true;
                } else {
                    const session = await auth.api.getSession({ headers: await nextHeaders() });
                    if (!session) {
                        redirectUrl = flow.origin;
                        isExternal = true;
                    } else if (!(await flujoValido(flow))) {
                        // La galleta de flujo (`qb.flow_state`) es JSON SIN FIRMAR: quien la edite
                        // puede quitar el `clientId` (y con él la puerta) o poner otro `origin`.
                        // Se vuelve a validar como lo hizo `/api/flow` al crearla. Sin código.
                        audit({
                            action: 'auth.code.denied',
                            clientId: flow.clientId ?? null,
                            userId: session.user.id,
                            meta: { callbackUrl: flow.origin, motivo: 'flujo_invalido' },
                        });
                        redirectUrl = '/sin-permiso';
                    } else if (!(await puedeEntrar(session.user.id, flow.clientId))) {
                        // Sin la llave `<app>.entrar` NO se acuña el código. La galleta de
                        // flujo se borra en el `finally`, así que la pantalla a la que se
                        // va no puede volver a lanzar el flujo: no hay bucle.
                        audit({
                            action: 'auth.code.denied',
                            clientId: flow.clientId ?? null,
                            userId: session.user.id,
                            meta: { callbackUrl: flow.origin },
                        });
                        // Un sondeo silencioso (`prompt=none`) no enseña ninguna pantalla: se
                        // devuelve a la aplicación con `?sso=none`, como hace `/api/flow/none`.
                        const sondeo = urlSsoNone(flow);
                        if (sondeo) {
                            redirectUrl = sondeo;
                            isExternal = true;
                        } else {
                            redirectUrl = urlSinPermiso(flow.clientId ?? '');
                        }
                    } else {
                        const { code } = await createAuthCode({
                            userId: session.user.id,
                            sessionId: session.session.id,
                            sessionToken: sessionCookie.value,
                            clientId: flow.clientId ?? 'unknown',
                            callbackUrl: flow.origin,
                            returnTo: (flow as { returnTo?: string }).returnTo ?? null,
                        });
                        const url = new URL(flow.origin);
                        url.searchParams.set('code', code);
                        redirectUrl = url.toString();
                        isExternal = true;
                        audit({
                            action: 'auth.code.create',
                            clientId: flow.clientId ?? null,
                            userId: session.user.id,
                            meta: { callbackUrl: flow.origin },
                        });
                    }
                }
            } else if (flow.origin) {
                redirectUrl = flow.origin;
            }
        }
    } catch (e) {
        logger.error('[auth/callback] error', { error: (e as Error).message });
    } finally {
        cookieStore.delete('qb.flow_state');
    }

    if (isExternal) return NextResponse.redirect(redirectUrl);
    return NextResponse.redirect(new URL(redirectUrl, BASE_URL));
}
