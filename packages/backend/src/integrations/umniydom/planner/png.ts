import { inflateSync } from 'node:zlib';
// Validate complete PNG structure and bounded decompression, not just the extension.
export function validatePng(base64: string) {
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.length > 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw Error('INVALID_IMAGE');
    let offset = 8, header = false, end = false; const parts: Buffer[] = [];
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
        if (length > bytes.length - offset - 12) throw Error('INVALID_IMAGE');
        const chunk = bytes.subarray(offset + 4, offset + 8 + length);
        let crc = 0xffffffff;
        for (const byte of chunk) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
        if (((crc ^ 0xffffffff) >>> 0) !== bytes.readUInt32BE(offset + 8 + length)) throw Error('INVALID_IMAGE');
        if (!header && type !== 'IHDR') throw Error('INVALID_IMAGE');
        if (type === 'IHDR') {
            if (header || length !== 13 || bytes.readUInt32BE(offset + 8) !== 1200 || bytes.readUInt32BE(offset + 12) !== 900 || bytes[offset + 16] !== 8 || ![2, 6].includes(bytes[offset + 17]!) || !bytes.subarray(offset + 18, offset + 21).equals(Buffer.alloc(3))) throw Error('INVALID_IMAGE');
            header = true;
        } else if (type === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length));
        else if (type === 'IEND') { if (length || !parts.length) throw Error('INVALID_IMAGE'); end = true; }
        else if (!['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)) throw Error('INVALID_IMAGE');
        offset += length + 12;
        if (end) break;
    }
    if (!end || offset !== bytes.length) throw Error('INVALID_IMAGE');
    const channels = bytes[25] === 6 ? 4 : 3, stride = 1200 * channels + 1;
    const raw = inflateSync(Buffer.concat(parts), { maxOutputLength: stride * 900 });
    if (raw.length !== stride * 900) throw Error('INVALID_IMAGE');
    for (let row = 0; row < 900; row++) if (raw[row * stride]! > 4) throw Error('INVALID_IMAGE');
}
