/**
 * Read-only: как реализация (sales_order) связана со сделкой 36178.
 * Бьём DEV_WEBHOOK, ничего не пишем.  npx tsx scripts/recon-realization-link.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const DEAL = '36178';
function hr(t: string): void { console.log(`\n${'='.repeat(74)}\n${t}\n${'='.repeat(74)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 2200) s = s.slice(0, 2200) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}

async function main(): Promise<void> {
	hr(`1) Сделка ${DEAL} — поля (ищем ссылку на заказ/реализацию)`);
	const deal = await tc<Record<string, unknown>>('crm.deal.get', { id: DEAL });
	if (deal) {
		const keys = Object.keys(deal).filter((k) => /ORDER|DOC|REALIZ|SHIP|STOCK|STORE|UF_/i.test(k));
		j('подозрительные поля', Object.fromEntries(keys.map((k) => [k, (deal as any)[k]])));
		console.log('  всего полей:', Object.keys(deal).length);
	}

	hr(`2) Активности сделки (crm.activity.list) — есть ли среди них реализация`);
	const acts = await tc<Array<Record<string, unknown>>>('crm.activity.list', {
		filter: { OWNER_TYPE_ID: 2, OWNER_ID: DEAL }, select: ['ID', 'PROVIDER_ID', 'PROVIDER_TYPE_ID', 'SUBJECT', 'TYPE_ID'], order: { ID: 'DESC' },
	}) ?? [];
	console.log('активностей:', acts.length);
	for (const a of acts.slice(0, 15)) console.log(`  PROVIDER=${a['PROVIDER_ID']}/${a['PROVIDER_TYPE_ID']} | TYPE=${a['TYPE_ID']} | ${String(a['SUBJECT'] ?? '').slice(0, 60)}`);

	hr('3) Подсистема заказов/реализаций — доступна ли вебхуку');
	await tc('sale.order.list', { filter: {} });
	await tc('crm.item.list', { entityTypeId: 31 });   // 31 — частый id «Реализация» в инвент-учёте
	await tc('catalog.document.list', { filter: { docType: 'W' }, select: ['id', 'docType', 'title'] }); // W = отгрузка?

	hr('4) catalog.document.list — ВСЕ docType ещё раз (вдруг есть продажный тип)');
	const docs = await tc<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', { select: ['id', 'docType', 'title'], order: { id: 'DESC' } });
	const types = new Map<string, number>();
	for (const d of docs?.documents ?? []) { const t = String(d['docType']); types.set(t, (types.get(t) ?? 0) + 1); }
	j('docType → кол-во (первая страница)', Object.fromEntries(types));

	hr('5) Привязки CRM (crm.deal — productrows STORE_ID как намёк на заказ)');
	const rows = await tc<Array<Record<string, unknown>>>('crm.deal.productrows.get', { id: DEAL }) ?? [];
	for (const r of rows) console.log(`  ${String(r['PRODUCT_NAME']).slice(0,40)} | TYPE=${r['TYPE']} | STORE_ID=${r['STORE_ID']} | RESERVE=${r['RESERVE_QUANTITY']}`);
	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
