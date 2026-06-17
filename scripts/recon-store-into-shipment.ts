/**
 * Read-only: можно ли подставить СКЛАД в черновик реализации через REST (стена 2, перепроверка).
 * Урок orderentity: скрытые методы не светятся в `methods` — пробуем ВЫЗОВАМИ.
 * Запись НЕ делаем: только getfields/list/get + existence-пробы `.add {}` (пустые поля,
 * валидация Б24 отбивает до какой-либо записи — так вчера нашли crm.orderentity.add).
 *
 * Углы:
 *  1) наш черновик #956/2 (заказ 956, shipment 1586) — если Сергей выбрал склад в UI,
 *     ГДЕ он виден через REST? (имя сущности = дверь для записи)
 *  2) sale.shipment / sale.shipmentitem getfields — есть ли store-поля
 *  3) скрытые имена вокруг shipmentitemstore / storebarcode
 *  4) catalog.document.* — видна ли реализация среди складских документов
 *  5) crm.item.productrow.fields — storeId/reserve у строки сделки (резерв-путь)
 *  6) reservations в заказе 956
 * Запуск: npx tsx scripts/recon-store-into-shipment.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const c = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const ORDER = 956, SHIPMENT = 1586;
function hr(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`); }
function j(l: string, d: unknown, cap = 2600): void { let s = JSON.stringify(d, null, 1); if (s && s.length > cap) s = s.slice(0, cap) + '…'; console.log(`${l}: ${s}`); }
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 4; a++) {
		try { const r = await c.call<T>(m, p); console.log(`  ✅ ${m} — ОК`); return r; }
		catch (e) {
			if (e instanceof B24ApiError) {
				const msg = `${e.code}:${e.description ?? ''}`;
				const notFound = /method not found/i.test(msg) || /ERROR_METHOD_NOT_FOUND/i.test(msg);
				console.log(`  ${notFound ? '⛔ НЕТ МЕТОДА' : '🟡 МЕТОД ЕСТЬ, ошибка'} ${m} → ${msg.slice(0, 140)}`);
				return null;
			}
			if (a === 4) { console.log(`  ⛔ ${m} → ${String(e)} (4 попытки)`); return null; }
			await wait(a * 700);
		}
	}
	return null;
}
const storeKeys = (o: Record<string, unknown> | undefined): string[] =>
	Object.keys(o ?? {}).filter((k) => /store|sklad|warehouse|barcode|reserv/i.test(k));

(async () => {
	hr(`1) НАШ ЧЕРНОВИК: shipment ${SHIPMENT} заказа ${ORDER} — где склад, если Сергей его выбрал?`);
	const sh = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', { filter: { orderId: ORDER }, select: ['*'] });
	for (const s of sh?.shipments ?? []) {
		j(`  shipment ${s['id']} (#${s['accountNumber']}) ВСЕ поля`, s, 3200);
		console.log('  store-подобные поля:', storeKeys(s).map((k) => `${k}=${JSON.stringify(s[k])}`).join(', ') || '(нет)');
	}
	const si = await tc<{ shipmentItems?: Array<Record<string, unknown>> }>('sale.shipmentitem.list', { filter: { orderDeliveryId: SHIPMENT }, select: ['*'] });
	for (const it of si?.shipmentItems ?? []) {
		j(`  shipmentItem ${it['id']} ВСЕ поля`, it);
		console.log('  store-подобные:', storeKeys(it).map((k) => `${k}=${JSON.stringify(it[k])}`).join(', ') || '(нет)');
	}

	hr('2) getfields: sale.shipment / sale.shipmentitem — store-поля в схеме');
	const shf = await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.getfields', {});
	j('  shipment store-поля', storeKeys(shf?.shipment));
	const sif = await tc<{ shipmentItem?: Record<string, unknown> }>('sale.shipmentitem.getfields', {});
	j('  shipmentItem store-поля', storeKeys(sif?.shipmentItem));
	j('  shipmentItem ВСЕ поля (имена)', Object.keys(sif?.shipmentItem ?? {}));

	hr('3) СКРЫТЫЕ ИМЕНА вокруг «склад строки отгрузки» (existence-пробы, пустые параметры)');
	for (const m of [
		'sale.shipmentitemstore.list', 'sale.shipmentitemstore.getfields', 'sale.shipmentitemstore.add',
		'sale.shipmentitem.store.list', 'sale.shipmentstore.list',
		'sale.storebarcode.list', 'sale.storebarcode.getfields', 'sale.storebarcode.add',
		'sale.shipmentitemstorebarcode.list',
		'catalog.shipmentitemstore.list',
		'sale.basketitemreservation.list', 'sale.basketitemreservation.add',
		'crm.itemreservation.list', 'crm.reservation.list',
		'catalog.storeproduct.reserve', 'catalog.product.reserve',
	]) await tc(m, {});

	hr('4) catalog.document.* — видна ли РЕАЛИЗАЦИЯ среди складских документов?');
	const docs = await tc<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', {
		order: { id: 'desc' }, select: ['id', 'docType', 'title', 'status', 'dateDocument', 'total'],
	});
	j('  последние документы (типы!)', (docs?.documents ?? []).slice(0, 15));
	for (const m of ['catalog.document.conduct', 'catalog.document.unconduct', 'catalog.document.element.list']) await tc(m, m.endsWith('element.list') ? { filter: { docId: 1 } } : {});

	hr('5) crm.item.productrow.fields — есть ли storeId/reserve у строки сделки (резерв-путь)');
	const prf = await tc<{ fields?: Record<string, unknown> }>('crm.item.productrow.fields', {});
	j('  productrow store/reserve-поля', storeKeys(prf?.fields));
	j('  productrow ВСЕ поля (имена)', Object.keys(prf?.fields ?? {}));

	hr(`6) Заказ ${ORDER}: basketItems с reservations (storeId резерва?)`);
	const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: ORDER });
	for (const b of ord?.order?.basketItems ?? []) {
		console.log(`  basket ${b['id']} ${String(b['name']).slice(0, 40)} qty=${b['quantity']} xmlId=${b['xmlId']}`);
		j('    reservations', b['reservations'] ?? '(нет)');
		console.log('    store-подобные:', storeKeys(b as Record<string, unknown>).map((k) => `${k}=${JSON.stringify((b as Record<string, unknown>)[k])}`).join(', ') || '(нет)');
	}

	hr('ГОТОВО (записи не было: только list/get/getfields + пустые existence-пробы)');
})().catch((e) => console.error('FATAL', e instanceof B24ApiError ? `${e.code}:${e.description ?? ''}` : e));
