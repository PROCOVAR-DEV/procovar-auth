/** Firmar APK exige el permiso explícito `auth.firma_apk` (Jose, 29/10/2026), que se reparte a los roles desde Accesos. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const acceso = vi.hoisted(() => ({ accesoDe: vi.fn() }));
vi.mock('@/lib/aplicaciones-visibles', () => acceso);

import { puedeFirmarApk, PERMISO_DE_FIRMA } from '../permiso-de-firma';

beforeEach(() => vi.resetAllMocks());

describe('quién puede firmar APK', () => {
    it('solo quien tiene la llave auth.firma_apk', async () => {
        expect(PERMISO_DE_FIRMA).toBe('auth.firma_apk');
        acceso.accesoDe.mockResolvedValue({ todo: false, llaves: new Set(['auth.firma_apk', 'auth.roles']) });
        expect(await puedeFirmarApk('u1')).toBe(true);
        acceso.accesoDe.mockResolvedValue({ todo: false, llaves: new Set(['auth.roles', 'delivery.entrar']) });
        expect(await puedeFirmarApk('u1')).toBe(false);
    });

    it('ser administrador global NO basta: la llave es explícita', async () => {
        acceso.accesoDe.mockResolvedValue({ todo: true, llaves: new Set() });
        expect(await puedeFirmarApk('admin')).toBe(false);
    });
});
