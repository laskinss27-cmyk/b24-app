/**
 * Read-only разведка под «полный каталог» Базы (показывать и нулевые остатки).
 * Вопросы:
 *  1) сколько товаров всего в iblock 24 (офферы) и 26 (товары)?
 *  2) отдаёт ли catalog.product.list нужные поля (property334/360/330/104, detailPicture,
 *     parentId, purchasingPrice) прямо в select — чтобы НЕ делать тысячи product.get?
 *  3) принимает ли catalog.price.list массив productId в фильтре — чтобы тянуть цены пачками?
 * Ничего не пишем.
 *
 * npx tsx scripts/recon-baza-full.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('no DEV_WEBHOOK'); process.exit(1); }
const c = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function totalOf(method: string, params: Record<string, unknown>): Promise<number | null> {
	try {
		const r = await c.callBatch({ probe: { method, params } });
		if (r.result_error['probe']) { console.log(`  ⛔ ${method} → ${JSON.stringify(r.result_error['probe'])}`); return null; }
		return r.result_total['probe'] ?? 0;
	} catch (e) { console.log(`  ⛔ ${method} → ${String(e)}`); return null; }
}
async function tryCall<T>(method: string, params: Record<string, unknown>): Promise<T | null> {
	try { return await c.call<T>(method, params); }
	catch (e) { console.log(`  ⛔ ${method} → ${e instanceof B24ApiError ? e.code + ': ' + e.description : String(e)}`); return null; }
}

async function main(): Promise<void> {
	console.log('=== 1. Объём каталога ===');
	for (const iblockId of [24, 26]) {
		const t = await totalOf('catalog.product.list', { select: ['id'], filter: { iblockId } });
		console.log(`  iblock ${iblockId}: ${t} товаров`);
	}

	console.log('\n=== 2. product.list со свойствами (iblock 24) — что реально вернётся ===');
	const select = ['id', 'iblockId', 'name', 'iblockSectionId', 'purchasingPrice', 'property360', 'property334', 'property330', 'property104', 'detailPicture', 'previewPicture', 'parentId'];
	const res = await tryCall<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		select, filter: { iblockId: 24 }, order: { id: 'ASC' },
	});
	const sample = res?.products?.slice(0, 3) ?? [];
	for (const p of sample) {
		console.log('  —', JSON.stringify({
			id: p['id'], name: String(p['name'] ?? '').slice(0, 30),
			property334: p['property334'], property360: p['property360'], property330: p['property330'],
			property104: p['property104'] ? '(есть)' : undefined,
			detailPicture: p['detailPicture'] ? '(есть)' : undefined,
			parentId: p['parentId'], purchasingPrice: p['purchasingPrice'], iblockSectionId: p['iblockSectionId'],
		}));
	}
	console.log('  ключи первой строки:', sample[0] ? Object.keys(sample[0]).join(', ') : '(нет)');

	console.log('\n=== 3. price.list массивом productId ===');
	const ids = (res?.products ?? []).slice(0, 5).map((p) => Number(p['id'])).filter((n) => n > 0);
	console.log('  пробую productId =', JSON.stringify(ids));
	const pr = await tryCall<{ prices?: Array<Record<string, unknown>> }>('catalog.price.list', {
		filter: { productId: ids, catalogGroupId: 2 }, select: ['productId', 'price', 'catalogGroupId'],
	});
	console.log('  prices вернулось:', pr?.prices?.length ?? 'null', '→', JSON.stringify(pr?.prices ?? []).slice(0, 400));

	console.log('\nГОТОВО — ничего не записано');
}
main().catch((e) => { console.error(e); process.exit(1); });
