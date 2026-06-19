/**
 * Заливка файла бэкапа на Б24 Диск (хранилище приложения вебхука).
 * Вызывается из core-backup.sh:  npx tsx core-backup-disk.ts <путь-к-файлу>
 * Метод повторяет рабочую заливку из api-repairs.ts (disk.storage.getforapp → uploadfile).
 */
import 'dotenv/config';
import { request } from 'undici';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
const file = process.argv[2];
if (!WEBHOOK) { console.error('нет DEV_WEBHOOK'); process.exit(1); }
if (!file) { console.error('usage: tsx core-backup-disk.ts <file>'); process.exit(1); }

async function b24<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const res = await request(`${WEBHOOK}/${method}.json`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(params),
		headersTimeout: 120000, bodyTimeout: 120000,
	});
	const j = (await res.body.json()) as { result?: T; error?: string; error_description?: string };
	if (j.error) throw new Error(`${j.error}: ${j.error_description ?? ''}`);
	return j.result as T;
}

async function main(): Promise<void> {
	const name = basename(file);
	const content = readFileSync(file).toString('base64');
	let storageId = 0;
	try { const s = await b24<{ ID?: number | string }>('disk.storage.getforapp', {}); storageId = Number(s?.ID) || 0; } catch { /* fallback ниже */ }
	if (!storageId) {
		const list = await b24<Array<{ ID?: number | string }>>('disk.storage.getlist', {});
		storageId = Number(list?.[0]?.ID) || 0;
	}
	if (!storageId) throw new Error('хранилище Диска не найдено');
	const f = await b24<Record<string, unknown>>('disk.storage.uploadfile', {
		id: storageId,
		data: { NAME: name },
		fileContent: [name, content],
		generateUniqueName: true,
	});
	console.log(`disk ok: id=${f?.['ID']} name=${f?.['NAME']}`);
}
main().catch((e) => { console.error('disk FATAL:', String(e).slice(0, 200)); process.exit(1); });
