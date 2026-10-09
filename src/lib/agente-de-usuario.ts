/**
 * Un `User-Agent` dicho en cristiano: «Chrome en Linux», «App de Reparto en Android».
 *
 * Lo comparten «Dispositivos y sesiones» y «Historial de inicios». Es una función pura y no
 * pretende acertar siempre —los agentes mienten desde hace veinte años—, sino dar algo
 * reconocible. Reutiliza los patrones de `desde-donde.ts` (el orden de allí importa: Edge y
 * Opera dicen «Chrome»).
 *
 * ## Qué es un `aparato`
 *
 * La app de Reparto (APK / escritorio) entra por `POST /api/auth/token`, y ese endpoint NO
 * recibe hoy un nombre ni una plataforma del aparato: sólo se queda con la cabecera
 * `User-Agent`, que en Flutter/Dart es `Dart/3.x (dart:io)` y no dice si es Android o
 * Windows. Se reconoce como `aparato` («App de Reparto») y la plataforma sale sólo si el agente
 * la nombra. Para distinguir teléfono de escritorio la app debería mandar su propio
 * `User-Agent` (p. ej. `ProcovarReparto/1.4 (Android 14)`): queda para una fase posterior, y
 * este parser ya lo entiende sin cambios.
 */
import { partesDelAgente } from '@/lib/desde-donde';

export type TipoDeAgente = 'navegador' | 'aparato' | 'desconocido';

export interface AgenteDescrito {
    /** Lo que se lee: «Chrome en Linux», «App de Reparto», «Dispositivo sin identificar». */
    texto: string;
    tipo: TipoDeAgente;
    /** Las mitades, por si hay que decirlas en otro idioma. Marcas: no se traducen. */
    navegador: string | null;
    sistema: string | null;
}

/** Dart/Flutter y las pilas HTTP nativas de Android e iOS, y cualquier agente que diga «reparto». */
const DE_APLICACION = /^dart\/|dart:io|okhttp|cfnetwork|reparto/i;

export function describirAgente(ua: string | null | undefined): AgenteDescrito {
    const crudo = (ua ?? '').trim();
    const { navegador, sistema } = partesDelAgente(crudo);

    // Antes que el navegador: un agente nativo puede nombrar un sistema (`Android`) sin ser un navegador.
    if (crudo && DE_APLICACION.test(crudo) && !navegador) {
        return {
            texto: sistema ? `App de Reparto en ${sistema}` : 'App de Reparto',
            tipo: 'aparato',
            navegador: null,
            sistema,
        };
    }
    if (navegador) {
        return { texto: sistema ? `${navegador} en ${sistema}` : navegador, tipo: 'navegador', navegador, sistema };
    }
    return { texto: sistema ?? 'Dispositivo sin identificar', tipo: 'desconocido', navegador: null, sistema };
}
