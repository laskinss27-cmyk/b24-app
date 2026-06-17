/**
 * Read-only: подсистема заказов/реализаций (нужен scope sale). Ищем связь заказ↔сделка.
 * npx tsx scripts/recon-sale.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
function hr(t: string): void { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2600) s = s.slice(0, 2600) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}

async function main(): Promise<void> {
	hr('1) sale.order.list — доступно ли + поля одного заказа');
	const orders = await tc<{ orders?: Array<Record<string, unknown>> }>('sale.order.list', { select: ['*'], order: { id: 'DESC' }, filter: {} });
	const list = orders?.orders ?? (Array.isArray(orders) ? orders as any : []);
	console.log('заказов в ответе:', Array.isArray(list) ? list.length : '?');
	if (list && list[0]) j('первый заказ (все поля)', list[0]);

	hr('2) Поля заказа (sale.order.getFields) — есть ли привязка к сделке');
	const f = await tc<{ order?: Record<string, unknown> }>('sale.order.getFields', {});
	if (f) {
		const keys = Object.keys((f as any).order ?? f);
		console.log('поля:', keys.join(', '));
	}

	hr('3) Привязка к CRM-сущности — sale.tradingPlatform / crm binding');
	await tc('crm.deal.details.configuration.get', {}); // не важно — просто проверка
	const orderId = (list && list[0]) ? Number((list[0] as any).id) : 0;
	if (orderId) {
		j('order id для проб', orderId);
		await tc('sale.order.get', { id: orderId });
	}

	hr('4) Отгрузки (sale.shipment.list)');
	const sh = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', { select: ['*'], order: { id: 'DESC' }, filter: {} });
	const shl = sh?.shipments ?? [];
	console.log('отгрузок:', Array.isArray(shl) ? shl.length : '?');
	if (shl && shl[0]) j('первая отгрузка', shl[0]);

	hr('5) Связь заказ→сделка: crm.deal ↔ order. Пробуем найти заказы сделки 36178');
	await tc('sale.order.list', { filter: {}, select: ['id', 'accountNumber', 'userId', 'price', 'dateInsert'] });
	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
