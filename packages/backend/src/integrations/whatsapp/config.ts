import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
export interface WhatsAppConfig {
    key: string;
    proxy?: string | undefined;
}
export function readWhatsAppConfig(stateDir: string): WhatsAppConfig | null {
    let value: unknown;
    try {
        value = JSON.parse(readFileSync(join(stateDir, 'whatsapp', 'config.json'), 'utf8'));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw Error('Invalid WhatsApp configuration');
    }
    return z.object({ key: z.string().regex(/^[a-f0-9]{64}$/i), proxy: z.string().url().refine(v => { const u = new URL(v); return ['socks5:', 'socks5h:'].includes(u.protocol) && Boolean(u.hostname) && Number(u.port) > 0 && Number(u.port) <= 65535; }).optional() }).strict().parse(value);
}
