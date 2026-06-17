/**
 * Read-only: проверяем, ПРАВИЛЬНО ли инвентаризация берёт базу товаров.
 *
 * Вопрос Сергея (2026-06-02): «простой» vs «с предложениями» (чёрный/белый).
 * В терминах Б24: type 1 = простой (остаток на товаре), type 3 = родитель SKU
 * (остатка нет), type 4 = оффер/вариант (остаток на нём).
 *
 * Что смотрим на складе Дунайский 64 (storeId 8) — тем же методом, что наш код:
 *   1. catalog.storeproduct.list → сколько строк остатка, какие поля.
 *   2. По выборке productId → catalog.product.get → распределение TYPE
 *      (ловим ли простые И офферы; не лезут ли родители).
 *   3. Примеры офферов: имя + property360 + РОДИТЕЛЬ — различимы ли чёрный/белый
 *      в том, что мы реально тянем (name/article).
 *
 * npx tsx scripts/recon-product-types.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const STORE_ID = 8; // Дунайский 64
const TYPE_NAME: Record<number, string> = { 1: 'простой', 2: 'комплект', 3: 'родитель-SKU', 4: 'оффер', 5: 'своб.оффер', 6: 'пустой-SKU', 7: 'услуга' };

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		console.log(`  ⛔ ${method} → ${err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err)}`);
		return null;
	}
}

async function main(): Promise<void> {
	// 1. Остатки склада — постранично (вебхук уважает start, в отличие от фронтового BX24)
	console.log(`=== catalog.storeproduct.list storeId=${STORE_ID} (как наш код) ===`);
	const rows: Array<Record<string, unknown>> = [];
	for (let start = 0; ; start += 50) {
		const res = await call<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', {
			filter: { storeId: STORE_ID },
			select: ['id', 'productId', 'amount', 'quantityReserved'],
			start,
		});
		const page = res?.storeProducts ?? [];
		rows.push(...page);
		if (page.length < 50) break;
		if (start > 5000) break; // предохранитель
	}
	console.log(`строк всего: ${rows.length}`);
	const withStock = rows.filter((r) => Number(r['amount'] ?? 0) > 0);
	console.log(`из них amount>0 (что берёт наш код): ${withStock.length}`);
	console.log('пример первых 3 строк (какие поля есть):', JSON.stringify(rows.slice(0, 3), null, 2));

	// 2. ТИП по ВСЕМ товарам склада (не выборка)
	const ids = [...new Set(withStock.map((r) => Number(r['productId'])).filter((x) => x > 0))];
	console.log(`\n=== TYPE по ВСЕМ ${ids.length} товарам склада (catalog.product.get) ===`);
	const typeCount: Record<string, number> = {};
	const byIblock: Record<string, number> = {};
	const offerExamples: number[] = [];
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of chunk) calls[`p${id}`] = { method: 'catalog.product.get', params: { id } };
		const batch = await client.callBatch(calls);
		for (const id of chunk) {
			const p = (batch.result[`p${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
			if (!p) { typeCount['нет-ответа'] = (typeCount['нет-ответа'] ?? 0) + 1; continue; }
			const t = Number(p['type'] ?? 0);
			typeCount[`${t} (${TYPE_NAME[t] ?? '?'})`] = (typeCount[`${t} (${TYPE_NAME[t] ?? '?'})`] ?? 0) + 1;
			const ib = String(p['iblockId'] ?? '?');
			byIblock[ib] = (byIblock[ib] ?? 0) + 1;
			if (t === 4 && offerExamples.length < 8) offerExamples.push(id);
		}
	}
	console.log('распределение типов на складе:', JSON.stringify(typeCount, null, 2));
	console.log('по iblock:', JSON.stringify(byIblock, null, 2));

	// 3. Есть ли в КАТАЛОГЕ товары «с предложениями» (type 3/4)? Сканируем оба iblock.
	console.log('\n=== Скан каталога по типам (cap 1500 на iblock) ===');
	for (const iblockId of [24, 26]) {
		const catTypes: Record<string, number> = {};
		const t3: number[] = [];
		const t4: number[] = [];
		for (let start = 0; start < 1500; start += 50) {
			const res = await call<Array<Record<string, unknown>>>('catalog.product.list', {
				filter: { iblockId },
				select: ['id', 'type', 'name'],
				start,
			});
			const page = res ?? [];
			for (const p of page) {
				const t = Number(p['type'] ?? 0);
				catTypes[`${t} (${TYPE_NAME[t] ?? '?'})`] = (catTypes[`${t} (${TYPE_NAME[t] ?? '?'})`] ?? 0) + 1;
				if (t === 3 && t3.length < 5) t3.push(Number(p['id']));
				if (t === 4 && t4.length < 8) t4.push(Number(p['id']));
			}
			if (page.length < 50) break;
		}
		console.log(`iblock ${iblockId}: ${JSON.stringify(catTypes)}; примеры type3=${JSON.stringify(t3)} type4=${JSON.stringify(t4)}`);
		offerExamples.push(...t4.filter((x) => !offerExamples.includes(x)));
	}

	// 4. Офферы: имя + property360 + РОДИТЕЛЬ + ЕСТЬ ли остаток на складе 8 (различим ли вариант?)
	console.log('\n=== Офферы (type 4): имя/артикул/родитель + остаток на складе 8 ===');
	if (!offerExamples.length) console.log('офферов type 4 в каталоге не нашлось вообще — каталог плоский (только простые)');
	for (const oid of offerExamples.slice(0, 8)) {
		const o = await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: oid });
		const prod = o?.product ?? {};
		const parentId = Number((prod['parentId'] as { value?: unknown } | undefined)?.value ?? prod['parentId'] ?? 0);
		let parentName = '';
		if (parentId) {
			const par = await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: parentId });
			parentName = String(par?.product?.['name'] ?? '');
		}
		const stock = await call<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { filter: { storeId: STORE_ID, productId: oid }, select: ['amount'] });
		console.log(JSON.stringify({ offerId: oid, offerName: prod['name'], property360: (prod['property360'] as { value?: unknown } | undefined)?.value, parentId, parentName, store8amount: stock?.storeProducts?.[0]?.['amount'] ?? 'нет строки' }));
	}

	console.log('\nГОТОВО — ничего не записано');
}

main().catch((err) => { console.error(err); process.exit(1); });
