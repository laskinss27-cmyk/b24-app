/**
 * Read-only: точные поля отгрузки/заказа для сборки окна «Реализации».
 * Запуск: npx tsx scripts/recon-real-fields.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2400) s = s.slice(0, 2400) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}
(async () => {
	console.log('=== sale.shipment.getfields (ВСЕ ключи) ===');
	const f = await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.getfields', {});
	console.log(Object.keys(f?.shipment ?? {}).join(', '));

	console.log('\n=== sale.shipment.get id=1504 (реализация 918/2) — реальные значения ===');
	j('shipment', (await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.get', { id: 1504 }))?.shipment ?? '(нет .get — пробуем list)');
	j('shipment(list)', ((await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', { filter: { id: 1504 } }))?.shipments ?? [])[0]);

	console.log('\n=== заказ 922 (компания «ИП Парфентьев»?) — поля клиента/ответственного ===');
	const o = (await tc<{ order?: Record<string, unknown> }>('sale.order.get', { id: 922 }))?.order as Record<string, unknown> | undefined;
	if (o) j('order поля', { responsibleId: o['responsibleId'], userId: o['userId'], personTypeId: o['personTypeId'], price: o['price'] });
	j('propertyvalue заказа 922', (await tc<{ propertyValues?: Array<Record<string, unknown>> }>('sale.propertyvalue.list', { filter: { orderId: 922 } }))?.propertyValues?.map((p) => ({ name: p['name'], code: p['code'], value: p['value'] })));
})().catch((e) => console.error('FATAL', e));
