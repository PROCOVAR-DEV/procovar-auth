/**
 * QUÉ APLICACIONES FIRMA LA CASA y con qué `applicationId` (docs/firma-de-apk.md). ESTE es el único sitio donde se cambia.
 *
 * Por qué una lista blanca por aplicación y no «cualquier APK»: la clave de la casa es la identidad de Procovar en todos los
 * teléfonos. Quien la use sobre una APK ajena (o sobre la de otra de nuestras apps, elegida por error en el desplegable) la
 * está dando por buena, y con esa firma un teléfono instala la APK ENCIMA de la nuestra. El `package` que lleva el
 * AndroidManifest de lo que se sube tiene que ser el de la aplicación elegida, y ninguno más.
 *
 * Las claves son los `clientId` del flujo de la APK (`CLIENTES_APK` de `apk-tokens.ts`; hay una prueba que lo comprueba).
 *
 * De dónde sale cada `applicationId` (leído el 29/10/2026):
 *   · Reparto        `delivery-logistica/app/android/app/build.gradle.kts` → `cloud.procovar.reparto`
 *   · Transferencias `transferencia-sms/movil/android/app/build.gradle.kts` → `cloud.procovar.transferencias`
 *   · CRM            `crm/mobile/app.json` (Expo, lo escribe Amado) → `com.procovar.crm`. OJO: no es de la casa en el sentido de
 *                    «cloud.procovar.*»; si Amado lo cambia, se cambia aquí y nada más.
 */

export interface AppDeFirma {
    /** Como se lee en la pantalla. */
    nombre: string;
    /** Los `applicationId` que se aceptan para ESTA aplicación (normalmente uno; más de uno solo si un día hay sabores). */
    paquetes: readonly string[];
}

export const APPS_DE_FIRMA: Readonly<Record<string, AppDeFirma>> = {
    'delivery-apk': { nombre: 'Reparto', paquetes: ['cloud.procovar.reparto'] },
    'transferencias-apk': { nombre: 'Transferencias', paquetes: ['cloud.procovar.transferencias'] },
    'crm-apk': { nombre: 'CRM', paquetes: ['com.procovar.crm'] },
};

/** La aplicación de ese `clientId`, o null si no es una de las que se firman (también para `__proto__` y compañía). */
export function appDeFirma(clientId: string | null | undefined): AppDeFirma | null {
    if (!clientId || !Object.hasOwn(APPS_DE_FIRMA, clientId)) return null;
    return APPS_DE_FIRMA[clientId];
}

/** ¿Es `paquete` uno de los `applicationId` permitidos de ESA aplicación? Comparación exacta: nada de prefijos. */
export function paqueteAdmitido(clientId: string, paquete: string): boolean {
    return appDeFirma(clientId)?.paquetes.includes(paquete) ?? false;
}
