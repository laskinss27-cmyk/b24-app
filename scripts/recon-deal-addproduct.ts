/**
 * Read-only: как безопасно ДОБАВИТЬ товар в сделку (пункт 2).
 *  - есть ли crm.item.productrow.add / .delete (добавить ОДНУ строку, не перезаписывая)?
 *  - поля строки (fields);
 *  - откуда цена товара (catalog.price.list BASE);
 *  - текущие строки тест-сделки через crm.item.productrow.list (=ownerType/=ownerId).
 * Запуск: npx tsx scripts/recon-deal-addproduct.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2200) s = s.slice(0, 2200) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== crm.item.productrow.fields (поля строки для add) ===');
	const f = await tc<{ fields?: Record<string, unknown> }>('crm.item.productrow.fields', {});
	console.log(f?.fields ? Object.keys(f.fields).join(', ') : '(нет fields)');

	console.log('\n=== существуют ли методы add/delete? (пробный вызов без записи — ждём ошибку валидации, НЕ method_not_found) ===');
	await tc('crm.item.productrow.add', {}); // ждём «required fields», значит метод ЕСТЬ
	await tc('crm.item.productrow.delete', {}); // ждём «id required», значит метод ЕСТЬ

	console.log('\n=== цена товара 15544: catalog.price.list (BASE) + catalog.product.get ===');
	j('price.list', await tc('catalog.price.list', { filter: { productId: 15544 }, select: ['id', 'productId', 'catalogGroupId', 'price', 'currency'] }));

	console.log('\n=== текущие строки сделки 36704 (тест Сергея) через crm.item.productrow.list ===');
	const rows = await tc<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', { filter: { '=ownerType': 'D', '=ownerId': 36704 } });
	console.log('строк:', (rows?.productRows ?? []).length);
	j('первая строка', (rows?.productRows ?? [])[0] ?? '(пусто)');
})().catch((e) => console.error('FATAL', e));
