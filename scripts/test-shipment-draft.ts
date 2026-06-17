/**
 * Продолжение теста: ЧЕРНОВИК ОТГРУЗКИ для заказа 956 (deducted=N, склад не двигается).
 * Тогда заказ должен стать видимым «Документом реализации» в UI.
 * Запуск: npx tsx scripts/test-shipment-draft.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const ORDER = 956, BASKET = 3532, QTY = 2;
function j(l: string, d: unknown): void { let s = JSON.stringify(d); if (s && s.length > 700) s = s.slice(0, 700) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T> {
	try { return await c.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e)}`.slice(0, 200)); throw e; }
}
(async () => {
	console.log('1) черновик отгрузки для заказа', ORDER);
	const sh = await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.add', {
		fields: { orderId: ORDER, deliveryId: 6, allowDelivery: 'N', deducted: 'N' }, // 6 = «Без доставки» (из заказа 918)
	});
	const SHIP = Number(sh?.shipment?.['id']);
	j('   отгрузка', { id: SHIP, account: sh?.shipment?.['accountNumber'] });

	console.log('2) строка отгрузки (привязка к корзине)');
	const si = await tc<{ shipmentItem?: Record<string, unknown> }>('sale.shipmentitem.add', {
		fields: { orderDeliveryId: SHIP, basketId: BASKET, quantity: QTY },
	});
	j('   строка', { id: si?.shipmentItem?.['id'] });

	console.log('3) контроль: отгрузки заказа', ORDER);
	const list = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		filter: { orderId: ORDER }, select: ['id', 'accountNumber', 'deducted', 'system'],
	});
	j('   shipments', list?.shipments);
	console.log(`\n✅ ГОТОВО: черновик реализации #...${SHIP} существует, склад НЕ тронут (deducted=N).`);
	console.log('Сергею: обнови карточку сделки 36754 (вкладка Товары/таймлайн) + список «Складской учёт → Реализация»');
	console.log('— должен появиться НЕпроведённый документ по заказу 956.');
})().catch(() => process.exit(1));
