/**
 * Read-only: полный список методов токена + фильтр на order/shipment/sale/realiz/document/
 * convert/binding/deal — ищем «создать заказ/реализацию из сделки» или метод привязки.
 * Запуск: npx tsx scripts/recon-methods-order.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	const all = (await tc<string[]>('methods', {})) ?? [];
	console.log('всего методов:', all.length);
	const re = /(order|shipment|sale|realiz|document|convert|binding|tradingplatform|deal\.)/i;
	const hit = all.filter((m) => re.test(m)).sort();
	console.log('\n=== order/shipment/sale/convert/binding/document/deal методы ===');
	for (const m of hit) console.log('  ' + m);

	console.log('\n=== sale.order.getfields — есть ли поле привязки к сделке (tradeBinding/deal/crm)? ===');
	const of = await tc<{ order?: Record<string, unknown> }>('sale.order.getfields', {});
	const keys = Object.keys(of?.order ?? {});
	console.log('  все поля заказа:', keys.join(', '));

	console.log('\n=== пробуем методы привязки/конвертации (валидационная ошибка = метод ЕСТЬ) ===');
	await tc('crm.deal.converter', {});
	await tc('sale.tradebinding.list', {});
	await tc('sale.tradebinding.fields', {});
	await tc('sale.order.fields', {});
})().catch((e) => console.error('FATAL', e));
