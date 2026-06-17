/**
 * NET-ZERO тест записи (пункт 2): добавить товар в сделку 36704 → проверить → удалить → проверить 0.
 * Ничего не остаётся. Запуск: npx tsx scripts/test-addproduct-netzero.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const PRODUCT = 15544, QTY = 2, PRICE = 9500;
function j(l: string, d: unknown): void { console.log(l + ': ' + JSON.stringify(d)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T> { try { return await c.call<T>(m, p); } catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); throw e; } }
async function rows(deal: number): Promise<Array<Record<string, unknown>>> {
	const r = await c.call<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', { filter: { '=ownerType': 'D', '=ownerId': deal } });
	return r?.productRows ?? [];
}
(async () => {
	console.log('0) создаю одноразовую тест-сделку');
	const DEAL = Number(await tc<number>('crm.deal.add', { fields: { TITLE: 'ТЕСТ add-product (автоудаление)', CATEGORY_ID: 0 } }));
	console.log('   сделка', DEAL);
	try {
		console.log('1) строк ДО:', (await rows(DEAL)).length);

		console.log('2) ADD товар', PRODUCT, '×', QTY, '@', PRICE);
		const added = await tc<{ productRow?: Record<string, unknown> }>('crm.item.productrow.add', {
			fields: { ownerType: 'D', ownerId: DEAL, productId: PRODUCT, price: PRICE, quantity: QTY },
		});
		const newId = Number(added?.productRow?.['id']);
		j('  добавлена строка', { id: newId, name: added?.productRow?.['productName'], price: added?.productRow?.['price'], qty: added?.productRow?.['quantity'] });

		const after = await rows(DEAL);
		console.log('3) строк ПОСЛЕ add:', after.length, '— видно в сделке:', after.some((x) => Number(x['id']) === newId));

		console.log('4) DELETE строки', newId);
		await tc('crm.item.productrow.delete', { id: newId });
		console.log('   строк после delete строки:', (await rows(DEAL)).length);
	} finally {
		console.log('5) удаляю тест-сделку', DEAL);
		await tc('crm.deal.delete', { id: DEAL });
		console.log('   ✅ NET-ZERO: тест-сделка удалена');
	}
})().catch((e) => console.error('FATAL', e));
