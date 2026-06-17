/**
 * Read-only: разворот xmlId корзины «crm_pr_<N>» → сделка.
 * Берём заказ 860 (есть отгрузка 860/2), вытаскиваем crm_pr_ из корзины,
 * пробуем crm.item.productrow.list/get по id строки → ownerType/ownerId (=сделка).
 * Запуск: npx tsx scripts/recon-crmpr-to-deal.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
function hr(t: string): void { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2500) s = s.slice(0, 2500) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}

async function main(): Promise<void> {
	const ORDER = 860;
	hr(`1) Заказ #${ORDER} — собираем crm_pr_<N> из корзины`);
	const ord = await tc<{ order?: { basketItems?: Array<Record<string, unknown>> } }>('sale.order.get', { id: ORDER });
	const basket = ord?.order?.basketItems ?? [];
	const rowIds: number[] = [];
	for (const b of basket) {
		const x = String(b['xmlId'] ?? '');
		const m = /^crm_pr_(\d+)$/.exec(x);
		console.log(`  basket ${b['id']} "${String(b['name']).slice(0,40)}" xmlId=${x}${m ? ` → rowId ${m[1]}` : ''}`);
		if (m) rowIds.push(Number(m[1]));
	}
	console.log('  rowIds:', rowIds);

	hr('2) crm.item.productrow.list по этим id — есть ли ownerType/ownerId (=сделка)?');
	const list = await tc<{ productRows?: Array<Record<string, unknown>> }>('crm.item.productrow.list', {
		filter: { '@id': rowIds },
	});
	for (const r of list?.productRows ?? []) {
		console.log(`  row ${r['id']}: ownerType=${r['ownerType']} ownerId=${r['ownerId']} product=${r['productName']} qty=${r['quantity']} price=${r['price']}`);
	}
	if (!(list?.productRows ?? []).length) {
		console.log('  list пуст — пробуем .get по первому id');
		if (rowIds[0]) j('crm.item.productrow.get', await tc('crm.item.productrow.get', { id: rowIds[0] }));
	}

	// собираем уникальные сделки
	const deals = new Set<number>();
	for (const r of list?.productRows ?? []) {
		if (Number(r['ownerType']) === 2 || String(r['ownerType']) === 'D') deals.add(Number(r['ownerId']));
	}
	hr('3) Найденные сделки → подтверждаем (crm.deal.get: название/клиент/сумма)');
	console.log('  уникальные ownerId(сделки):', [...deals]);
	for (const id of deals) {
		const d = await tc<Record<string, unknown>>('crm.deal.get', { id });
		if (d) console.log(`  СДЕЛКА #${id}: "${d['TITLE']}" сумма=${d['OPPORTUNITY']} стадия=${d['STAGE_ID']} contact=${d['CONTACT_ID']} company=${d['COMPANY_ID']}`);
	}
	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
