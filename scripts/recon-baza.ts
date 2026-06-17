/**
 * Read-only разведка под «Базу товаров»: замер масштаба + источник «розницы».
 * Ничего не пишем. Только totals (через batch.result_total) и пара sample-чтений.
 *
 *  - сколько складов;
 *  - сколько строк storeproduct ВСЕГО и с остатком>0 (объём данных для браузера);
 *  - типы цен (catalog.priceType.list) — какой = «Розница»;
 *  - форма catalog.price.list для sample-товара;
 *  - размер каталога по iblock 24/26 (catalog.product.list total).
 *
 * npx tsx scripts/recon-baza.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		if (err instanceof B24ApiError) console.log(`  ⛔ ${method} → ${err.code}: ${err.description ?? ''}`);
		else console.log(`  ⛔ ${method} → ${String(err)}`);
		return null;
	}
}

/** total из конверта через одиночный batch (call() его не отдаёт). */
async function totalOf(method: string, params: Record<string, unknown>): Promise<number | null> {
	try {
		const res = await client.callBatch({ probe: { method, params } });
		if (res.result_error['probe']) {
			console.log(`  ⛔ ${method} → ${JSON.stringify(res.result_error['probe'])}`);
			return null;
		}
		return res.result_total['probe'] ?? 0;
	} catch (err) {
		console.log(`  ⛔ ${method} (batch) → ${String(err)}`);
		return null;
	}
}

async function main(): Promise<void> {
	console.log('=== склады ===');
	const stores = await tryCall<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', { select: ['id', 'title', 'active'], order: { id: 'ASC' } });
	const slist = stores?.stores ?? [];
	console.log(`складов: ${slist.length}`);
	for (const s of slist) console.log(`  #${s['id']} ${s['title']} active=${s['active']}`);

	console.log('\n=== объём складских позиций (storeproduct) ===');
	const spAll = await totalOf('catalog.storeproduct.list', { select: ['id'] });
	const spPos = await totalOf('catalog.storeproduct.list', { select: ['id'], filter: { '>amount': 0 } });
	console.log(`строк storeproduct ВСЕГО: ${spAll}`);
	console.log(`строк storeproduct с остатком>0: ${spPos}`);

	console.log('\n=== размер каталога (catalog.product.list по iblock) ===');
	for (const iblockId of [24, 26]) {
		const t = await totalOf('catalog.product.list', { select: ['id'], filter: { iblockId } });
		console.log(`  iblock ${iblockId}: товаров ${t}`);
	}

	console.log('\n=== типы цен (catalog.priceType.list) ===');
	const pt = await tryCall<{ priceTypes?: Array<Record<string, unknown>> }>('catalog.priceType.list', {});
	for (const t of pt?.priceTypes ?? []) console.log(`  #${t['id']} base=${t['base']} name=${t['name']} title=${t['xmlId'] ?? ''} ${JSON.stringify(t['name'] ?? '')}`);

	// sample товар с остатком>0 → его цена
	console.log('\n=== sample: цена товара (catalog.price.list) ===');
	const sp = await tryCall<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { select: ['productId', 'storeId', 'amount'], filter: { '>amount': 0 }, order: { productId: 'ASC' } });
	const samplePid = Number(sp?.storeProducts?.[0]?.['productId'] ?? 0);
	console.log(`sample productId = ${samplePid}`);
	if (samplePid) {
		const prices = await tryCall<{ prices?: Array<Record<string, unknown>> }>('catalog.price.list', { filter: { productId: samplePid }, select: ['id', 'catalogGroupId', 'price', 'currency'] });
		console.log('  catalog.price.list →', JSON.stringify(prices?.prices ?? [], null, 2).slice(0, 900));
		const prod = await tryCall<{ product?: Record<string, unknown> }>('catalog.product.get', { id: samplePid });
		const p = prod?.product ?? {};
		console.log('  product поля цен:', JSON.stringify({ purchasingPrice: p['purchasingPrice'], price: p['price'], iblockId: p['iblockId'], iblockSectionId: p['iblockSectionId'] }));
	}

	console.log('\nГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
