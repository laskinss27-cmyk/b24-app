/**
 * Read-only: процессы «Снабжение» (1110) и «Заказ поставщику» (1070) — связь со сделками
 * с «Требуется заказ оборудования = Да» (36686/36668/36666/36640/36554). Поля карточек:
 * где перечень оборудования, кто ответственный.
 * Запуск: npx tsx scripts/recon-supply-1110.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 5; a++) {
		try { return await c.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${e.description ?? ''}`); return null; }
			if (a === 5) { console.log(`  ⛔ ${m} → ${String(e)}`); return null; }
			await wait(a * 800);
		}
	}
	return null;
}
const short = (v: unknown, n = 200): string => { const s = JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
const DEALS = [36686, 36668, 36666, 36640, 36554, 36556];

(async () => {
	for (const tid of [1110, 1070]) {
		console.log(`\n=== Свежие карточки entityTypeId=${tid} ===`);
		const list = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
			entityTypeId: tid, order: { id: 'desc' }, select: ['id', 'title', 'stageId', 'assignedById', 'parentId2', 'createdTime'],
		});
		for (const i of (list?.items ?? []).slice(0, 10)) console.log(`  [${i['id']}] «${String(i['title']).slice(0, 55)}» deal=${i['parentId2']} stage=${i['stageId']} assigned=${i['assignedById']} ${i['createdTime']}`);

		console.log(`--- карточки ${tid} наших сделок (${DEALS.join(',')}) ---`);
		const byDeal = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', {
			entityTypeId: tid, filter: { '@parentId2': DEALS }, select: ['id', 'title', 'parentId2'],
		});
		const found = byDeal?.items ?? [];
		for (const i of found) console.log(`  deal ${i['parentId2']} → [${i['id']}] «${String(i['title']).slice(0, 55)}»`);
		const first = found[0];
		if (first) {
			const full = await tc<{ item?: Record<string, unknown> }>('crm.item.get', { entityTypeId: tid, id: Number(first['id']) });
			console.log(`--- ПОЛНАЯ карточка [${first['id']}] (${tid}) — непустые поля ---`);
			for (const [k, v] of Object.entries(full?.item ?? {})) {
				if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
				console.log(`    ${k} = ${short(v)}`);
			}
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
