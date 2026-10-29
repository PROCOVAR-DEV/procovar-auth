/**
 * Los fallos de la firma de APK, con un CÓDIGO y una frase que se pueden enseñar tal cual.
 *
 * Lo que sale por la API es solo el código y esta frase: nunca el texto de un error de Java, de apksigner ni una ruta del
 * servidor (eso va al log y ahí se queda).
 */

const MENSAJES = {
    app_desconocida: ['Esa aplicación no está entre las que se firman.', 400],
    sin_cuerpo: ['No llegó ningún fichero.', 400],
    demasiado_grande: ['La APK pesa más de lo permitido (120 MB).', 413],
    apk_invalida: ['El fichero no es una APK válida (no se puede leer como ZIP con su AndroidManifest.xml).', 422],
    paquete_no_permitido: ['El paquete de esa APK no es el de la aplicación elegida. No se firma.', 422],
    firma_ocupada: ['Ya hay una firma en curso. Espera a que termine y vuelve a intentarlo.', 429],
    sin_clave: ['Todavía no se ha importado la clave de firma de la casa (ver docs/firma-de-apk.md).', 409],
    clave_ilegible: ['La clave guardada no se puede descifrar. Avisa a un desarrollador: no se firma nada.', 500],
    herramienta_no_disponible: ['Este servidor no tiene las herramientas de firma (Java, apksigner, zipalign).', 503],
    tiempo_agotado: ['La firma tardó demasiado y se cortó.', 504],
    firma_fallida: ['No se pudo firmar la APK.', 422],
    verificacion_fallida: ['La APK firmada no pasó la verificación. No se entrega.', 500],
    huella_distinta: ['La APK firmada NO lleva el certificado de la casa. No se entrega.', 500],
} as const;

export type CodigoDeFirma = keyof typeof MENSAJES;

export class ErrorDeFirma extends Error {
    readonly estado: number;
    constructor(public readonly codigo: CodigoDeFirma) {
        super(MENSAJES[codigo][0]);
        this.estado = MENSAJES[codigo][1];
    }
}
