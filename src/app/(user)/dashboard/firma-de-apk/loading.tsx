import { EsqueletoPagina } from "@/components/layout/esqueleto-pagina";

/** El hueco de «Firma de las APK» mientras el servidor la resuelve (ver `dashboard/loading.tsx`). */
export default function Cargando() {
  return <EsqueletoPagina filas={4} />;
}
