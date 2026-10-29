/**
 * LA LISTA BLANCA DE LA FIRMA DE APK (lib/firma-apk-apps.ts): cada aplicación solo firma SU applicationId.
 */
import { describe, it, expect } from 'vitest';
import { APPS_DE_FIRMA, appDeFirma, paqueteAdmitido } from '../firma-apk-apps';

describe('la lista blanca de paquetes por aplicación', () => {
    it('Reparto, Transferencias y CRM firman su paquete', () => {
        expect(paqueteAdmitido('delivery-apk', 'cloud.procovar.reparto')).toBe(true);
        expect(paqueteAdmitido('transferencias-apk', 'cloud.procovar.transferencias')).toBe(true);
        expect(paqueteAdmitido('crm-apk', 'com.procovar.crm')).toBe(true);
    });

    it('el paquete de OTRA de nuestras aplicaciones no vale (elegir mal el desplegable no firma la que no es)', () => {
        expect(paqueteAdmitido('delivery-apk', 'cloud.procovar.transferencias')).toBe(false);
        expect(paqueteAdmitido('transferencias-apk', 'cloud.procovar.reparto')).toBe(false);
        expect(paqueteAdmitido('crm-apk', 'cloud.procovar.reparto')).toBe(false);
    });

    it('la comparación es exacta: ni prefijos, ni mayúsculas, ni sufijos', () => {
        expect(paqueteAdmitido('delivery-apk', 'cloud.procovar.reparto.debug')).toBe(false);
        expect(paqueteAdmitido('delivery-apk', 'cloud.procovar')).toBe(false);
        expect(paqueteAdmitido('delivery-apk', 'Cloud.Procovar.Reparto')).toBe(false);
        expect(paqueteAdmitido('delivery-apk', 'cloud.procovar.reparto ')).toBe(false);
        expect(paqueteAdmitido('delivery-apk', '')).toBe(false);
    });

    it('una aplicación que no está en la lista no firma nada, ni con nombres de Object.prototype', () => {
        for (const id of ['otra-apk', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
            expect(appDeFirma(id)).toBeNull();
            expect(paqueteAdmitido(id, 'cloud.procovar.reparto')).toBe(false);
        }
        expect(appDeFirma(null)).toBeNull();
        expect(appDeFirma(undefined)).toBeNull();
    });

    it('cada aplicación tiene nombre y al menos un paquete válido', () => {
        for (const a of Object.values(APPS_DE_FIRMA)) {
            expect(a.nombre.length).toBeGreaterThan(0);
            expect(a.paquetes.length).toBeGreaterThan(0);
            for (const p of a.paquetes) expect(p).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
        }
    });

    it('las claves son los clientId de las APK del flujo de acceso (CLIENTES_APK), ni uno inventado', async () => {
        // Se lee el fuente: importar `apk-tokens` arrastraría Redis y Prisma a una prueba que no los necesita.
        const { readFileSync } = await import('node:fs');
        const fuente = readFileSync(new URL('../apk-tokens.ts', import.meta.url), 'utf8');
        const linea = /export const CLIENTES_APK = \[([^\]]+)\]/.exec(fuente)?.[1] ?? '';
        const porDefecto = /export const CLIENTE_POR_DEFECTO = '([^']+)'/.exec(fuente)?.[1] ?? '';
        const clientes = [porDefecto, ...[...linea.matchAll(/'([^']+)'/g)].map((m) => m[1])];
        expect(clientes.length).toBeGreaterThan(0);
        for (const id of Object.keys(APPS_DE_FIRMA)) expect(clientes).toContain(id);
    });

    it('ningún paquete se repite entre aplicaciones (uno solo no puede ser de dos)', () => {
        const todos = Object.values(APPS_DE_FIRMA).flatMap((a) => [...a.paquetes]);
        expect(new Set(todos).size).toBe(todos.length);
    });
});
