/**
 * Read-only разведка под НОВУЮ цель: «открывая реализацию — видеть сделку».
 * Идём ОТ реализации (sale.shipment) и ищем выход на сделку любым способом.
 * Бьём DEV_WEBHOOK, НИЧЕГО не пишем.  Запуск: npx tsx scripts/recon-real-deal-link.ts
 *
 * Углы:
 *  1) Есть ли «Реализация» как СМАРТ-ПРОЦЕСС (crm.type.list) — тогда у item есть привязка к сделке.
 *  2) Полный набор полей sale.shipment и sale.order — нет ли где CRM/deal-намёка (XML_ID, ACCOUNT_NUMBER…).
 *  3) Свойства заказа (sale.propertyvalue) реального заказа с отгрузкой.
 *  4) Эвристика: по клиенту/сумме реализации — сколько кандидатов-сделок (насколько уникально).
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void { console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`); }
function j(l: string, d: unknown): void { let s = JSON.stringify(d, null, 1); if (s && s.length > 3000) s = s.slice(0, 3000) + '…'; console.log(`${l}: ${s}`); }
async function tc<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code + ':' + (e.description ?? '') : String(e)}`); return null; }
}

async function main(): Promise<void> {
	// ── 1) СМАРТ-ПРОЦЕССЫ: есть ли «Реализация»/«Отгрузка»/«Поставка» как СПА ───────
	hr('1) crm.type.list — все типы CRM (вдруг «Реализация» = смарт-процесс с привязкой к сделке)');
	const types = await tc<{ types?: Array<Record<string, unknown>> }>('crm.type.list', {});
	for (const t of types?.types ?? []) {
		console.log(`  entityTypeId=${t['entityTypeId']} | code=${t['code']} | "${t['title']}"`);
	}
	// если найдём «реализ/отгруз/поставк» — перечислим items и глянем привязки
	const real = (types?.types ?? []).find((t) => /реализ|отгруз|поставк|shipment|sale/i.test(String(t['title'] ?? '')));
	if (real) {
		hr(`1b) Смарт-процесс "${real['title']}" (entityTypeId=${real['entityTypeId']}) — первые items + поля привязок`);
		const items = await tc<{ items?: Array<Record<string, unknown>> }>('crm.item.list', { entityTypeId: Number(real['entityTypeId']) });
		j('первый item', (items?.items ?? [])[0] ?? '(пусто)');
	} else {
		console.log('  → смарт-процесса «Реализация» НЕТ (значит это классический sale.shipment)');
	}

	// ── 2) РЕАЛИЗАЦИЯ со стороны sale.shipment ──────────────────────────────────────
	hr('2) sale.shipment.getfields — все поля отгрузки (ищем CRM/deal-намёк)');
	const shFields = await tc<{ shipment?: Record<string, unknown> }>('sale.shipment.getfields', {});
	const shKeys = Object.keys(shFields?.shipment ?? {});
	console.log('  всего полей отгрузки:', shKeys.length);
	j('  поля с CRM/DEAL/ORDER/XML/ACCOUNT в имени', shKeys.filter((k) => /crm|deal|order|xml|account|external/i.test(k)));

	hr('3) Свежие проведённые отгрузки (sale.shipment.list, deducted=Y)');
	const ships = await tc<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
		select: ['id', 'orderId', 'accountNumber', 'deducted', 'dateInsert', 'priceDelivery', 'currency'],
		filter: { deducted: 'Y' }, order: { id: 'DESC' },
	});
	const ship = (ships?.shipments ?? [])[0];
	j('первая отгрузка', ship ?? '(нет проведённых отгрузок)');
	if (!ship) { hr('НЕТ ОТГРУЗОК — дальше нечего разбирать'); return; }
	const orderId = Number(ship['orderId']);

	// ── 4) ЗАКАЗ этой отгрузки — все поля ───────────────────────────────────────────
	hr('4) sale.order.getfields — все поля заказа (ищем CRM/deal-намёк)');
	const ordFields = await tc<{ order?: Record<string, unknown> }>('sale.order.getfields', {});
	const ordKeys = Object.keys(ordFields?.order ?? {});
	console.log('  всего полей заказа:', ordKeys.length);
	j('  поля с CRM/DEAL/XML/ACCOUNT/EXTERNAL в имени', ordKeys.filter((k) => /crm|deal|xml|account|external|source/i.test(k)));

	hr(`5) Сам заказ #${orderId} — ВСЕ поля (XML_ID/ACCOUNT_NUMBER/userId — нет ли следа сделки)`);
	const ord = await tc<{ order?: Record<string, unknown> }>('sale.order.get', { id: orderId });
	j('заказ', ord?.order ?? '(sale.order.get не дал — пробуем list)');
	if (!ord?.order) {
		const ol = await tc<{ orders?: Array<Record<string, unknown>> }>('sale.order.list', { filter: { id: orderId } });
		j('заказ (list)', (ol?.orders ?? [])[0] ?? '(пусто)');
	}
	const order = ord?.order as Record<string, unknown> | undefined;

	hr(`6) Свойства заказа #${orderId} (sale.propertyvalue.list) — ФИО/телефон/что угодно про сделку`);
	const props = await tc<{ propertyValues?: Array<Record<string, unknown>> }>('sale.propertyvalue.list', { filter: { orderId } });
	for (const p of props?.propertyValues ?? []) console.log(`  ${p['name'] ?? p['code']} = ${JSON.stringify(p['value'])}`);
	if (!(props?.propertyValues ?? []).length) console.log('  (свойств нет / метод не отдал)');

	// ── 7) ЭВРИСТИКА: по клиенту+сумме заказа — сколько сделок-кандидатов ────────────
	hr('7) ЭВРИСТИКА — насколько уникально матчится сделка по клиенту/сумме');
	const userId = Number(order?.['userId'] ?? 0);
	const sum = Number(order?.['price'] ?? order?.['sumPaid'] ?? 0);
	console.log(`  заказ: userId(покупатель)=${userId}, сумма=${sum}, дата=${order?.['dateInsert']}`);
	// userId заказа — это профиль покупателя, не CRM-контакт. Попробуем достать его и связать с CRM.
	if (userId) {
		const u = await tc<Array<Record<string, unknown>>>('user.get', { ID: userId });
		j('  покупатель (user.get)', (u ?? [])[0] ?? '(нет)');
	}
	// сколько выигранных сделок с такой же суммой (грубая оценка уникальности матча)
	if (sum > 0) {
		const sameSum = await tc<Array<Record<string, unknown>>>('crm.deal.list', {
			filter: { OPPORTUNITY: sum, STAGE_SEMANTIC_ID: 'S' }, select: ['ID', 'TITLE', 'CLOSEDATE', 'CONTACT_ID', 'COMPANY_ID'],
		}) ?? [];
		console.log(`  выигранных сделок с суммой ровно ${sum}: ${sameSum.length}`);
		for (const d of sameSum.slice(0, 8)) console.log(`    #${d['ID']} "${String(d['TITLE']).slice(0,40)}" closed=${d['CLOSEDATE']} contact=${d['CONTACT_ID']} company=${d['COMPANY_ID']}`);
	}

	hr('ГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
