/**
 * A1 (auditoría 08/10/2026): cualquier persona autenticada podía hacer `POST /api/auth/organization/create`,
 * quedar `owner` de su propia organización y desde ahí tocar membresías ajenas. Se prueba con better-auth
 * DE VERDAD (adaptador en memoria) y con las opciones REALES del plugin que lleva `lib/auth.ts`.
 */
import { describe, it, expect } from 'vitest';
import { betterAuth } from 'better-auth';
import { organization } from 'better-auth/plugins';
import { memoryAdapter } from 'better-auth/adapters/memory';

type PluginOrg = { id: string; options?: Parameters<typeof organization>[0] };

async function opcionesReales() {
    const { auth } = await import('@/lib/auth');
    const plugin = (auth.options.plugins as PluginOrg[]).find((p) => p.id === 'organization');
    expect(plugin, 'lib/auth.ts debe llevar el plugin organization').toBeTruthy();
    return plugin!.options;
}

function nueva(opciones: Parameters<typeof organization>[0]) {
    return betterAuth({
        baseURL: 'http://localhost:3500',
        secret: 'un-secreto-de-pruebas-de-mas-de-32-caracteres',
        database: memoryAdapter({ user: [], session: [], account: [], verification: [], organization: [], member: [], invitation: [] }),
        emailAndPassword: { enabled: true },
        plugins: [organization(opciones)],
    });
}

async function conSesion(auth: ReturnType<typeof nueva>) {
    const r = await auth.api.signUpEmail({
        body: { email: 'a@procovar.local', password: 'una-clave-larga-123', name: 'Ana' },
        returnHeaders: true,
    });
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    return { headers: new Headers({ cookie }), userId: r.response.user.id };
}

describe('crear una organización', () => {
    it('con las opciones de lib/auth.ts, una persona autenticada sin rol NO puede crearla (403)', async () => {
        const auth = nueva(await opcionesReales());
        const { headers } = await conSesion(auth);
        await expect(
            auth.api.createOrganization({ body: { name: 'Mía', slug: 'mia' }, headers }),
        ).rejects.toMatchObject({ status: 'FORBIDDEN' });
    });

    it('CONTROL: con las opciones por defecto de la librería sí podía (queda owner) — lo que se arregló', async () => {
        const auth = nueva({});
        const { headers } = await conSesion(auth);
        const org = await auth.api.createOrganization({ body: { name: 'Mía', slug: 'mia' }, headers });
        expect(org?.members?.[0]?.role).toBe('owner');
    });

    it('por HTTP: POST /api/auth/organization/create tampoco crea nada', async () => {
        const auth = nueva(await opcionesReales());
        const { headers } = await conSesion(auth);
        headers.set('content-type', 'application/json');
        headers.set('origin', 'http://localhost:3500');
        const res = await auth.handler(
            new Request('http://localhost:3500/api/auth/organization/create', {
                method: 'POST', headers, body: JSON.stringify({ name: 'Mía', slug: 'mia' }),
            }),
        );
        expect(res.status).toBe(403);
    });
});
