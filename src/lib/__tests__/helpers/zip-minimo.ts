import { deflateRawSync } from 'node:zlib';

/** Un ZIP mínimo con las entradas dadas (método 0 = guardado, 8 = deflate). Solo para fabricar casos malos. */
export function zip(entradas: { nombre: string; datos: Buffer; metodo?: 0 | 8; tamReal?: number }[], comentario = ''): Buffer {
    const locales: Buffer[] = [];
    const centrales: Buffer[] = [];
    let desde = 0;
    for (const e of entradas) {
        const metodo = e.metodo ?? 0;
        const datos = metodo === 8 ? deflateRawSync(e.datos) : e.datos;
        const nombre = Buffer.from(e.nombre);
        const l = Buffer.alloc(30);
        l.writeUInt32LE(0x04034b50, 0);
        l.writeUInt16LE(metodo, 8);
        l.writeUInt32LE(datos.length, 18);
        l.writeUInt32LE(e.tamReal ?? e.datos.length, 22);
        l.writeUInt16LE(nombre.length, 26);
        locales.push(l, nombre, datos);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(metodo, 10);
        c.writeUInt32LE(datos.length, 20);
        c.writeUInt32LE(e.tamReal ?? e.datos.length, 24);
        c.writeUInt16LE(nombre.length, 28);
        c.writeUInt32LE(desde, 42);
        centrales.push(c, nombre);
        desde += 30 + nombre.length + datos.length;
    }
    const dirCentral = Buffer.concat(centrales);
    const fin = Buffer.alloc(22);
    fin.writeUInt32LE(0x06054b50, 0);
    fin.writeUInt16LE(entradas.length, 8);
    fin.writeUInt16LE(entradas.length, 10);
    fin.writeUInt32LE(dirCentral.length, 12);
    fin.writeUInt32LE(desde, 16);
    fin.writeUInt16LE(Buffer.byteLength(comentario), 20);
    return Buffer.concat([...locales, dirCentral, fin, Buffer.from(comentario)]);
}
