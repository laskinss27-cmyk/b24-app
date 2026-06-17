/**
 * Read-only: что Битрикс даёт для «Быстрой продажи» и можно ли прикрутить к нашей «Базе товаров».
 * Интроспекция методов (sale/order/deal/terminal/payment/salescenter/crm.item) + .fields ключевых.
 * Ничего не пишем.
 *
 * npx tsx scripts/recon-quicksale.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e)}`); return null; }
}

async function main(): Promise<void> {
	const all = (await call<string[]>('methods', {})) ?? [];
	console.log(`всего методов в токене: ${all.length}`);
	const rx = /sale|order|deal|terminal|payment|salescenter|crm\.item|productrow|catalog\.document|shipment|delivery|receivepayment/i;
	const hits = all.filter((n) => rx.test(n)).sort();
	console.log('\n=== методы по продаже/заказу/сделке ===');
	console.log(JSON.stringify(hits, null, 1));

	// шейпы ключевых сущностей (read-only .fields)
	const probes = ['crm.deal.fields', 'crm.deal.productrows.fields', 'sale.order.fields', 'salescenter.api.getfields', 'crm.item.fields', 'crm.terminal.fields'];
	for (const m of probes) {
		console.log(`\n=== ${m} ===`);
		const r = await call<unknown>(m, m === 'crm.item.fields' ? { entityTypeId: 2 } : {});
		if (r) console.log(JSON.stringify(r, null, 1).slice(0, 700));
	}
	console.log('\nГОТОВО — ничего не записано');
}
main().catch((e) => { console.error(e); process.exit(1); });
