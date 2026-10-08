import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * «Mi cuenta» y «Configurar perfil» son UNA sola pantalla (Jose, 08/10/2026):
 * `/profile`, con la configuración debajo en `#configurar-perfil`.
 *
 * Sin DOM en este repositorio (ver `salidas-de-la-puerta.test.ts`): el redirect de
 * `/profile/me` se ejecuta de verdad con `redirect` simulado; la composición se vigila en
 * el fuente, que es donde se puede romper.
 */

const redirect = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ redirect }));

const raiz = (...p: string[]) => path.join(process.cwd(), ...p);
const leer = (...p: string[]) => readFileSync(raiz(...p), 'utf8');
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('/profile/me ya no es una pantalla', () => {
	beforeEach(() => redirect.mockClear());

	it('redirige a /profile#configurar-perfil', async () => {
		const { default: Pagina } = await import('../me/page');
		Pagina();
		expect(redirect).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledWith('/profile#configurar-perfil');
	});

	it('no deja un loading.tsx ni el cliente viejo', () => {
		expect(() => statSync(raiz('src/app/(user)/profile/me/loading.tsx'))).toThrow();
		expect(() => statSync(raiz('src/components/profile/personal/mi-perfil-client.tsx'))).toThrow();
	});
});

describe('/profile lleva dentro la configuración', () => {
	const CONTENIDO = sinComentarios(leer('src/components/profile/profile-content.tsx'));
	const SECCIONES = sinComentarios(leer('src/components/profile/personal/mi-perfil-secciones.tsx'));

	it('el resumen incluye las secciones, y estas tienen el ancla y las tres partes', () => {
		expect(CONTENIDO).toContain('<MiPerfilSecciones />');
		expect(SECCIONES).toContain('id="configurar-perfil"');
		for (const parte of ['<ProfileEditor', '<SecuritySection />', '<NotificationsSection />']) {
			expect(SECCIONES).toContain(parte);
		}
	});

	it('sin segunda cabecera ni botón de volver', () => {
		expect(SECCIONES).not.toContain('ProfilePageShell');
		expect(SECCIONES).not.toContain('<h1');
	});

	it('el botón del resumen es el ancla de la propia página', () => {
		expect(CONTENIDO).toContain('href="#configurar-perfil"');
	});
});

describe('lo que la persona completa sale en Mi cuenta', () => {
	it('el teléfono (lo que edita ProfileEditor) se lee en el servidor y se pinta en el resumen', () => {
		expect(leer('src/app/(user)/profile/page.tsx')).toContain('phone: true');
		expect(sinComentarios(leer('src/components/profile/profile-content.tsx'))).toContain('user.phone');
	});

	it('guardar un campo refresca la página del servidor', () => {
		const editor = sinComentarios(leer('src/components/profile/personal/profile-editor.tsx'));
		expect(editor).toContain('router.refresh()');
	});
});

describe('el menú lateral', () => {
	const MENU = sinComentarios(leer('src/components/layout/armazon.tsx'));

	it('tiene Mi cuenta y ya no tiene Configurar perfil', () => {
		expect(MENU).toContain('href: "/profile"');
		expect(MENU).not.toContain('/profile/me');
		expect(MENU).not.toContain('configurarPerfil');
	});
});

describe('nadie más enlaza a /profile/me', () => {
	// Ni la propia redirección lo nombra: solo existe como ruta (la carpeta `me/`).
	function ficheros(dir: string): string[] {
		return readdirSync(dir).flatMap((n) => {
			const p = path.join(dir, n);
			if (statSync(p).isDirectory()) return n === '__tests__' ? [] : ficheros(p);
			return /\.(tsx?|json)$/.test(n) ? [p] : [];
		});
	}

	it('ni en src ni en los mensajes', () => {
		const con = [...ficheros(raiz('src')), ...ficheros(raiz('messages'))]
			.filter((f) => sinComentarios(readFileSync(f, 'utf8')).includes('profile/me'))
			.map((f) => path.relative(raiz(), f));
		expect(con).toEqual([]);
	});
});
