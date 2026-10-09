import { z } from 'zod';
import type { SocksProxyType } from 'teleproto/network/connection/TCPMTProxy.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TelegramError } from './store.js';
export interface TelegramConfig { apiId: number; apiHash: string; key: string; proxy?: SocksProxyType }
// A single source supplies the whole tuple: never silently mix encryption keys.
export function readTelegramConfig(stateDir: string, env: NodeJS.ProcessEnv = process.env): TelegramConfig | null {
 let values: Record<string, unknown>;
 if (['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION_KEY'].some(k => Boolean(env[k]))) {
  values = { apiId: env['TELEGRAM_API_ID'], apiHash: env['TELEGRAM_API_HASH'], key: env['TELEGRAM_SESSION_KEY'] };
 } else {
  try { values = JSON.parse(readFileSync(join(stateDir, 'telegram', 'config.json'), 'utf8')) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new TelegramError('Не удалось прочитать серверную конфигурацию Telegram', 503); }
 }
 const apiId = Number(values?.['apiId']), apiHash = String(values?.['apiHash'] ?? ''), key = String(values?.['key'] ?? '');
 if (!Number.isSafeInteger(apiId) || apiId <= 0 || !/^[a-f0-9]{32}$/i.test(apiHash) || !/^[a-f0-9]{64}$/i.test(key)) throw new TelegramError('Проверьте API-параметры и ключ хранения Telegram на сервере', 503);
 const rawProxy = values['proxy'];
 if (rawProxy === undefined) return { apiId, apiHash, key };
 const parsedProxy = z.object({ ip: z.string().min(1).max(253).regex(/^[a-zA-Z0-9_.:-]+$/), port: z.number().int().min(1).max(65535), socksType: z.literal(5), username: z.string().max(255).optional(), password: z.string().max(255).optional() }).strict().safeParse(rawProxy);
 if (!parsedProxy.success) throw new TelegramError('Проверьте настройки SOCKS5-прокси Telegram на сервере',503);
 const { ip, port, socksType, username, password } = parsedProxy.data;
 return { apiId, apiHash, key, proxy: { ip, port, socksType, ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) } };
}