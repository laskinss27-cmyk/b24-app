/**
 * ТЕСТ записи «Быстрой продажи» (обратимый, net-zero): создаём сделку в кат.6 со стадией
 * C6:NEW + 2 строки товара, проверяем crm.deal.get / productrows.get, затем УДАЛЯЕМ сделку.
 * Прод-CRM не засоряется. Цель — убедиться, что API записи работает, до сборки UI.
 *
 * npx tsx scripts/recon-quicksale-test.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m: string, p: Record<string, unknown> = {}): Promise<T> {
	try { return await c.call<T>(m, p); }
	catch (e) { throw new Error(`${m}: ${e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e)}`); }
}

async function main(): Promise<void> {
	// два реальных товара из каталога (из разведки): 1924 Жёсткий диск, 7454 Аудиотрубки
	const items = [
		{ productId: 1924, name: 'ТЕСТ Жёсткий диск', price: 35000, quantity: 1 },
		{ productId: 7454, name: 'ТЕСТ Аудиотрубки', price: 5700, quantity: 3 },
	];

	console.log('1) crm.deal.add (кат.6, стадия C6:NEW)…');
	const dealId = await call<number>('crm.deal.add', {
		fields: { TITLE: 'ТЕСТ Быстрая продажа (авто-удалится)', CATEGORY_ID: 6, STAGE_ID: 'C6:NEW', OPENED: 'Y' },
	});
	console.log(`   создана сделка #${dealId}`);

	console.log('2) crm.deal.productrows.set (корзина)…');
	await call('crm.deal.productrows.set', {
		id: dealId,
		rows: items.map((it) => ({ PRODUCT_ID: it.productId, PRODUCT_NAME: it.name, PRICE: it.price, QUANTITY: it.quantity })),
	});

	console.log('3) проверка crm.deal.get…');
	const deal = await call<Record<string, unknown>>('crm.deal.get', { id: dealId });
	console.log('   CATEGORY_ID=', deal['CATEGORY_ID'], 'STAGE_ID=', deal['STAGE_ID'], 'TITLE=', deal['TITLE'], 'OPPORTUNITY=', deal['OPPORTUNITY']);

	console.log('4) проверка crm.deal.productrows.get…');
	const rows = await call<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: dealId });
	for (const r of rows) console.log(`   PRODUCT_ID=${r['PRODUCT_ID']} «${r['PRODUCT_NAME']}» PRICE=${r['PRICE']} QTY=${r['QUANTITY']}`);

	console.log('5) crm.deal.delete (чистка)…');
	await call('crm.deal.delete', { id: dealId });
	console.log(`   сделка #${dealId} удалена`);

	console.log('\n✅ API записи работает. Прод-CRM чист (сделка удалена).');
}
main().catch((e) => { console.error('❌', e); process.exit(1); });
