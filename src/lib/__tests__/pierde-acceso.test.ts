/** La decisión «¿esto le quita algo a alguien?»: sólo entonces se avisa a las aplicaciones. */
import { describe, it, expect } from 'vitest';
import { pierdeLlaves, sucursalPierdeAcceso, cambioDeRolPuedeQuitar } from '../pierde-acceso';

describe('pierdeLlaves', () => {
    it('añadir llaves no quita nada', () => expect(pierdeLlaves(['a'], ['a', 'b'])).toBe(false));
    it('igual no quita nada, aunque cambie el orden', () => expect(pierdeLlaves(['a', 'b'], ['b', 'a'])).toBe(false));
    it('quitar una sí', () => expect(pierdeLlaves(['a', 'b'], ['a'])).toBe(true));
    it('cambiar una por otra sí (la vieja se pierde)', () => expect(pierdeLlaves(['a'], ['b'])).toBe(true));
    it('de nada a algo no quita; de algo a nada sí', () => {
        expect(pierdeLlaves([], ['a'])).toBe(false);
        expect(pierdeLlaves(['a'], [])).toBe(true);
    });
});

describe('sucursalPierdeAcceso', () => {
    const base = { activa: true, codigo: 'CAM' };
    it('guardar sin cambios no', () => expect(sucursalPierdeAcceso(base, { ...base })).toBe(false));
    it('desactivar sí', () => expect(sucursalPierdeAcceso(base, { ...base, activa: false })).toBe(true));
    it('reactivar no', () => expect(sucursalPierdeAcceso({ ...base, activa: false }, base)).toBe(false));
    it('cambiar el código sí (también de/hacia nulo)', () => {
        expect(sucursalPierdeAcceso(base, { ...base, codigo: 'CMG' })).toBe(true);
        expect(sucursalPierdeAcceso(base, { ...base, codigo: null })).toBe(true);
        expect(sucursalPierdeAcceso({ ...base, codigo: null }, base)).toBe(true);
    });
});

describe('cambioDeRolPuedeQuitar', () => {
    it('ascender no', () => {
        expect(cambioDeRolPuedeQuitar('agent', 'staff')).toBe(false);
        expect(cambioDeRolPuedeQuitar('staff', 'admin')).toBe(false);
        expect(cambioDeRolPuedeQuitar('admin', 'owner')).toBe(false);
    });
    it('igual no', () => expect(cambioDeRolPuedeQuitar('admin', 'admin')).toBe(false));
    it('bajar sí', () => {
        expect(cambioDeRolPuedeQuitar('owner', 'admin')).toBe(true);
        expect(cambioDeRolPuedeQuitar('admin', 'agent')).toBe(true);
    });
    it('un rol fuera de la escala se trata como posible pérdida', () => {
        expect(cambioDeRolPuedeQuitar('ADMINISTRADOR', 'admin')).toBe(true);
        expect(cambioDeRolPuedeQuitar('admin', 'GESTOR')).toBe(true);
    });
});
