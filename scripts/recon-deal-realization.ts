/**
 * Read-only: является ли САМА сделка реализацией? Смотрим выигранную сделку —
 * склад/резерв в строках, поля сделки, и есть ли отгрузка/реализация через order/shipment.
 * Бьём DEV_WEBHOOK, ничего не пишем.  Запуск: npx tsx scripts/recon-deal-realization.ts
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
	// выигранная сделка с товарами (из быстрой продажи розницы)
	const won = await tc<Array<Record<string, unknown>>>('crm.deal.list', {
		filter: { STAGE_SEMANTIC_ID: 'S', '!OPPORTUNITY': 0 }, select: ['ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'CLOSEDATE'], order: { CLOSEDATE: 'DESC' },
	}) ?? [];
	const deal = won[0];
	if (!deal) { console.log('нет выигранных сделок'); return; }
	const id = Number(deal['ID']);
	hr(`СДЕЛКА #${id} — ${deal['TITLE']} (стадия ${deal['STAGE_ID']})`);

	hr('1) СТРОКИ сделки — склад, резерв (STORE_ID / RESERVE_QUANTITY / DATE_RESERVE_END)');
	const rows = await tc<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id }) ?? [];
	for (const r of rows) {
		console.log(`  ${r['PRODUCT_NAME']} | TYPE=${r['TYPE']} | qty=${r['QUANTITY']} | STORE_ID=${r['STORE_ID']} | RESERVE_QUANTITY=${r['RESERVE_QUANTITY']} | DATE_RESERVE_END=${r['DATE_RESERVE_END']}`);
	}

	hr('2) Остаток этих товаров на их складе (storeproduct) — списан ли при выигрыше?');
	for (const r of rows.filter((x) => Number(x['TYPE']) !== 7).slice(0, 4)) {
		const pid = Number(r['PRODUCT_ID']);
		const sp = await tc<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { filter: { productId: pid }, select: ['storeId', 'amount', 'quantityReserved'] });
		j(`  product ${pid} (${r['PRODUCT_NAME']})`, sp?.storeProducts ?? []);
	}

	hr('3) Есть ли отгрузка/реализация через ЗАКАЗ (order/shipment)? Пробуем методы');
	await tc('sale.shipment.list', { filter: {} });
	await tc('sale.order.list', { filter: {} });
	await tc('crm.item.list', { entityTypeId: 31 }); // 31 = смарт-процесс «Реализация»? проверим
	const orders = await tc<{ orders?: Array<Record<string, unknown>> }>('crm.deal.contact.fields', {});
	void orders;

	hr('4) Поля сделки про склад/отгрузку (фильтр по имени)');
	const fields = await tc<Record<string, Record<string, unknown>>>('crm.deal.fields', {});
	if (fields) {
		const hit = Object.keys(fields).filter((k) => /STORE|SHIP|STOCK|DELIV|RESERV|REALIZ|WAREHOUSE/i.test(k));
		j('поля сделки про склад/отгрузку', hit.length ? hit : '(нет таких полей)');
	}
	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
