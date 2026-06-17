/**
 * Read-only: чем РЕАЛЬНО отличаются вариации-тёзки? Берём трубки 7500-7510 и LM UKT-2
 * (18828-18836, 18922), тянем ВСЕ поля и печатаем только те, что отличаются между ними.
 * Сеть к Б24 — через curl с локальным прокси (VPN-клиент Сергея).
 * Запуск: npx tsx scripts/recon-offer-diff.ts
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function b24call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 5; a++) {
		try {
			const { stdout } = await execFileP('curl.exe', [
				'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
				'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
			], { maxBuffer: 64 * 1024 * 1024 });
			const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
			return json.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

const flat = (v: unknown): string => {
	if (v && typeof v === 'object' && 'value' in (v as object)) return String((v as { value: unknown }).value);
	return JSON.stringify(v);
};

(async () => {
	for (const ids of [[7500, 7502, 7504, 7506, 7508, 7510], [18828, 18830, 18832, 18834, 18836, 18922]]) {
		console.log(`\n=== вариации ${ids.join(', ')} ===`);
		const res = await b24call<{ products?: Record<string, Record<string, unknown>> | Array<Record<string, unknown>> }>('catalog.product.list', {
			filter: { iblockId: 26, '@id': ids }, select: ['id', 'iblockId', '*'], order: { id: 'ASC' },
		});
		const rows = Array.isArray(res?.products) ? res.products : Object.values(res?.products ?? {});
		console.log(`получено: ${rows.length}`);
		if (rows.length < 2) continue;
		const keys = new Set<string>();
		for (const r of rows) for (const k of Object.keys(r)) keys.add(k);
		for (const k of [...keys].sort()) {
			const vals = rows.map((r) => flat(r[k]));
			if (new Set(vals).size > 1) {
				console.log(`  ОТЛИЧАЕТСЯ ${k}:`);
				rows.forEach((r, i) => console.log(`     [${r['id']}] = ${vals[i]?.slice(0, 90)}`));
			}
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
