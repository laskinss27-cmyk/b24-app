/**
 * Read-only валидация математики отчёта по продажам на РЕАЛЬНЫХ сделках.
 * Бьём DEV_WEBHOOK, ничего не пишем. Цель — понять, врут ли суммы/прибыль и почему:
 *   - совпадает ли (сумма товаров + сумма услуг) с OPPORTUNITY сделки;
 *   - что лежит в строках (PRICE vs PRICE_EXCLUSIVE/NETTO, есть ли TYPE, DISCOUNT_SUM);
 *   - сколько товарных позиций без закупки (catalog.product.purchasingPrice).
 *
 * Запуск: npx tsx scripts/recon-report-validate.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void { console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`); }
async function tryCall<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
const WORK = 7;

async function main(): Promise<void> {
	const deals = await tryCall<Array<Record<string, unknown>>>('crm.deal.list', {
		filter: { STAGE_SEMANTIC_ID: 'S' },
		select: ['ID', 'TITLE', 'OPPORTUNITY', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'CLOSEDATE'],
		order: { CLOSEDATE: 'DESC' },
	}) ?? [];
	console.log(`выигранных (первая страница): ${deals.length}`);
	const sample = deals.slice(0, 6);

	let dumpedRaw = false;
	for (const d of sample) {
		const id = Number(d['ID']);
		hr(`Сделка #${id} — ${String(d['TITLE'] ?? '')}  | OPPORTUNITY=${d['OPPORTUNITY']} | CAT=${d['CATEGORY_ID']}`);
		const rows = await tryCall<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id }) ?? [];

		// один раз показать СЫРЫЕ поля строки — чтобы увидеть PRICE vs PRICE_EXCLUSIVE и наличие TYPE
		if (!dumpedRaw && rows[0]) {
			console.log('  СЫРАЯ первая строка (все поля):');
			console.log('  ' + JSON.stringify(rows[0], null, 1).replace(/\n/g, '\n  '));
			dumpedRaw = true;
		}

		let goodsSum = 0, worksSum = 0, goodsProfit = 0, noPurchase = 0, goodsSumExcl = 0;
		const goodsIds: number[] = [];
		for (const r of rows) {
			if (Number(r['TYPE']) !== WORK && Number(r['PRODUCT_ID'] ?? 0) > 0) goodsIds.push(Number(r['PRODUCT_ID']));
		}
		// закупки
		const purchase = new Map<number, number | null>();
		for (let i = 0; i < goodsIds.length; i += 40) {
			const chunk = goodsIds.slice(i, i + 40);
			const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
			for (const pid of chunk) calls['p' + pid] = { method: 'catalog.product.get', params: { id: pid } };
			const res = await client.callBatch(calls);
			for (const pid of chunk) {
				const p = (res.result['p' + pid] as { product?: Record<string, unknown> } | undefined)?.product;
				const pp = p ? p['purchasingPrice'] : null;
				purchase.set(pid, pp == null || pp === '' ? null : Number(pp));
			}
		}
		for (const r of rows) {
			const price = Number(r['PRICE'] ?? 0);
			const priceExcl = Number(r['PRICE_EXCLUSIVE'] ?? r['PRICE'] ?? 0);
			const qty = Number(r['QUANTITY'] ?? 0);
			if (Number(r['TYPE']) === WORK) { worksSum += price * qty; }
			else {
				goodsSum += price * qty;
				goodsSumExcl += priceExcl * qty;
				const pp = purchase.get(Number(r['PRODUCT_ID'] ?? 0));
				if (pp == null) noPurchase++; else goodsProfit += (price - pp) * qty;
			}
		}
		const opp = Number(d['OPPORTUNITY'] ?? 0);
		const my = goodsSum + worksSum;
		console.log(`  строк: ${rows.length} | сумма товаров(PRICE)=${goodsSum} услуг=${worksSum} | ИТОГО мой=${my} vs OPPORTUNITY=${opp} | Δ=${Math.round((my - opp) * 100) / 100}`);
		console.log(`  товары по PRICE_EXCLUSIVE=${goodsSumExcl} (если Δ выше большая — PRICE уже со скидкой/налогом)`);
		console.log(`  прибыль товаров=${Math.round(goodsProfit)} | позиций без закупки=${noPurchase}/${goodsIds.length}`);
	}
	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
