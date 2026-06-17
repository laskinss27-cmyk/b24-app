/**
 * Read-only: запись 7390 списка «кассы/точки» (iblock 60) — что за поля, кто/когда менял,
 * есть ли признаки версионирования. Запуск: npx tsx scripts/recon-kassa-elem.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	for (const t of ['lists', 'bitrix_processes', 'lists_socnet']) {
		const r = await tc<Array<Record<string, unknown>>>('lists.element.get', { IBLOCK_TYPE_ID: t, IBLOCK_ID: 60, ELEMENT_ID: 7390 });
		if (r && r.length) {
			const e = r[0]!;
			console.log(`=== IBLOCK_TYPE_ID=${t}, элемент 7390 ===`);
			for (const [k, v] of Object.entries(e)) {
				if (v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
				console.log(`  ${k} = ${JSON.stringify(v)}`);
			}
			break;
		}
	}
})().catch((e) => console.error('FATAL', e));
