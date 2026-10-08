/**
 * GET /api/flow/none
 *
 * Ends a silent SSO probe (`?prompt=none`) when there is no IdP session: clears
 * the flow cookie and bounces the browser back to the calling app with
 * `?sso=none`, so that app renders as anonymous instead of being shown a login
 * form it never asked for.
 *
 * This lives in a route handler on purpose. The sign-in page used to clear the
 * cookie inline while rendering, but Next.js only allows cookie writes from a
 * server action or a route handler — during render it throws, which surfaced as
 * a 500 on `/` for every logged-out visitor arriving through the probe.
 */
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getFlowState, urlSsoNone } from '@/lib/flow-state';

const FLOW_COOKIE = 'qb.flow_state';

export async function GET() {
    const baseUrl = process.env.APP_URL || 'http://localhost:3500';
    const flowState = await getFlowState();

    // The probe is over either way: drop the cookie so a fallback to `/` shows
    // the sign-in form instead of bouncing through here again.
    const cookieStore = await cookies();
    cookieStore.delete(FLOW_COOKIE);

    const back = urlSsoNone(flowState);
    return NextResponse.redirect(back ?? new URL('/', baseUrl));
}
