/**
 * Read-only: свежая сделка Сергея (сегодня, ~274к, кабель + монитор) — какие TYPE у строк?
 * Гипотеза: монитор не отображается во вкладке из-за фильтра TYPE (1=товар/7=работа).
 * Запуск: npx tsx scripts/recon-monitor-type.ts
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
(async () => {
	const deals = await tc<Array<Record<string, unknown>>>('crm.deal.list', {
		filter: { '>=DATE_CREATE': '2026-06-11' },
		select: ['ID', 'TITLE', 'OPPORTUNITY', 'DATE_CREATE'],
		order: { ID: 'DESC' },
	});
	for (const d of (deals ?? []).slice(0, 6)) {
		console.log(`\nсделка ${d['ID']} «${String(d['TITLE']).slice(0, 45)}» сумма=${d['OPPORTUNITY']} (${d['DATE_CREATE']})`);
		const rows = await tc<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: Number(d['ID']) });
		for (const r of rows ?? []) {
			console.log(`  строка ${r['ID']}: «${String(r['PRODUCT_NAME']).slice(0, 45)}» TYPE=${JSON.stringify(r['TYPE'])} qty=${r['QUANTITY']} price=${r['PRICE']} productId=${r['PRODUCT_ID']}`);
		}
	}
	console.log('\nГОТОВО (read-only)');
})().catch((e) => console.error('FATAL', e));
