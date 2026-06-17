/**
 * Read-only: фундамент под кнопку «Реализовать» во вкладке сделки.
 * Вопросы: (1) как устроена МУЛЬТИСКЛАДСКАЯ реализация (#918 — с 2 складов): один shipment с
 * несколькими store или несколько shipment? как в данных видно «5 с А, 5 с Б»?
 * (2) есть ли у заказа/отгрузки настраиваемое ИМЯ (task 3)?
 * (3) жив ли sale.shipmentitemstore.* (стена 2)?
 * (4) путь через РЕЗЕРВ: storeId в reservations — кандидат на «откуда списать».
 * Запуск: npx tsx scripts/recon-real-create-foundation.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
function hr(t: string): void { console.log(`\n${'='.repeat(76)}\n${t}\n${'='.repeat(76)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2600) s = s.slice(0, 2600) + '…'; console.log(`${l}: ${s}`); }
function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	for (let a = 1; a <= 4; a++) {
		try { return await client.call<T>(m, p); }
		catch (e) {
			if (e instanceof B24ApiError) { console.log(`  ⛔ ${m} → ${e.code}:${e.description ?? ''}`); return null; }
			if (a === 4) { console.log(`  ⛔ ${m} → ${String(e)} (4 попытки)`); return null; }
			await wait(a * 700);
		}
	}
	return null;
}

async function main(): Promise<void> {
	const ORDER = 918; // реализация #918/2 — с двух складов (по скрину)

	hr(`1) МУЛЬТИСКЛАД: отгрузки заказа #${ORDER} (sale.shipment.list по orderId)`);
	const sh = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', { filter: { orderId: ORDER }, select: ['id', 'orderId', 'accountNumber', 'deducted', 'storeId'] });
	j('отгрузки', sh?.shipments ?? []);

	hr(`2) Состав заказа #${ORDER} — reservations со storeId по каждой строке`);
	const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: ORDER });
	for (const b of ord?.order?.basketItems ?? []) {
		const res = (b['reservations'] as Array<Record<string, unknown>>) ?? [];
		console.log(`  ${String(b['name']).slice(0, 38)} | qty=${b['quantity']} | xmlId=${b['xmlId']}`);
		for (const r of res) console.log(`      reserve: storeId=${r['storeId']} qty=${r['quantity']}`);
	}

	hr('3) Строки ОТГРУЗКИ (sale.shipmentitem.list) — где склад? Есть ли разбивка по складам?');
	const firstShip = (sh?.shipments ?? [])[0];
	if (firstShip) {
		const si = await tc<{ shipmentItems?: Array<Record<string, unknown>> }>('sale.shipmentitem.list', { filter: { orderDeliveryId: Number(firstShip['id']) } });
		j('shipmentItems', si?.shipmentItems ?? []);
		const sit = await tc<{ shipmentItem?: Record<string, unknown> }>('sale.shipmentitem.getfields', {});
		j('поля shipmentitem', Object.keys(sit?.shipmentItem ?? {}));
	}

	hr('4) СТЕНА 2 — жив ли sale.shipmentitemstore.* (склад на строку отгрузки)?');
	await tc('sale.shipmentitemstore.list', { filter: {} });
	await tc('sale.shipmentitemstore.getfields', {});

	hr('5) ИМЯ реализации (task 3): поля sale.order / sale.shipment с name/title/comment');
	const of = await tc<{ order?: Record<string, unknown> }>('sale.order.getfields', {});
	const ok = Object.keys(of?.order ?? {}).filter((k) => /name|title|comment|info|user.?descr|account/i.test(k));
	j('  order поля-кандидаты на имя', ok);
	const shf = await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.getfields', {});
	const shk = Object.keys(shf?.shipment ?? {}).filter((k) => /name|title|comment|info|tracking/i.test(k));
	j('  shipment поля-кандидаты на имя', shk);
	// что реально лежит в заказе #918 по этим полям
	const o918 = ord?.order as Record<string, unknown> | undefined;
	if (o918) j('  значения у заказа #918', Object.fromEntries(ok.map((k) => [k, o918[k]])));

	hr('6) РЕЗЕРВ-путь: можно ли резервировать со склада через REST? (методы)');
	await tc('sale.basketitem.getfields', {}).then((r: any) => j('  basketitem поля (reserv/store?)', Object.keys(r?.basketItem ?? {}).filter((k: string) => /reserv|store|quantity/i.test(k))));
	console.log('  методы записи резерва — проверим существование getfields:');
	await tc('sale.basketitemreservation.getfields', {});  // гипотетический
	await tc('catalog.storeproduct.getfields', {});

	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
