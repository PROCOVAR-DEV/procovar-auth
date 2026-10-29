/**
 * QUIÉN PUEDE FIRMAR APK — Jose, 29/10/2026: se decide con un PERMISO de Accesos (`auth.firma_apk`), que él reparte a los roles desde
 * «Roles y permisos»; NO con nombres de rol escritos en el código.
 *
 * Se exige en el servidor (la página y el endpoint de firma), además de ser administrador global. Es una llave EXPLÍCITA: ni siquiera
 * un administrador global la tiene sin que un rol suyo se la dé (`accesoDe` marca `todo` para ellos, pero aquí solo cuenta `llaves`).
 */
import { accesoDe } from '@/lib/aplicaciones-visibles';

export const PERMISO_DE_FIRMA = 'auth.firma_apk';

export async function puedeFirmarApk(userId: string): Promise<boolean> {
    const acceso = await accesoDe(userId);
    return acceso.llaves.has(PERMISO_DE_FIRMA);
}
