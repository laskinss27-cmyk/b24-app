/**
 * ПРОБА ФУНДАМЕНТА перемещений: честный транзит А → Goods In Transit → Б нашим токеном.
 * Создаёт тестовый товар (вне «Каталог Б24», синк его не трогает), оприходует, делает
 * ДВА Material Transfer через транзит, проверяет остатки (Bin.actual_qty) на каждом шаге,
 * затем ОТКАТЫВАЕТ всё (cancel, docstatus=2) — ядро остаётся чистым.
 *
 * Запуск на спейре:  cd ~/sync && npx tsx test-transit-probe.ts
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';

const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? '';
const localAgent = new Agent();

const COMPANY = 'Умный дом';
const WH_A = 'Максидом Дунайский 64 - УД';
const TRANSIT = 'Goods In Transit - УД';
const WH_B = 'Максидом Богатырский 15 - УД';
const ITEM = 'ZZ-TRANSIT-TEST';
const GROUP = 'ZZ Тест перемещений';
const UOM = 'шт';
const QTY = 3;

async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await undiciRequest(`${ERP}${path}`, {
		method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		dispatcher: localAgent,
	});
	const text = await res.body.text();
	let json: any = null;
	try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
	return { status: res.statusCode, json };
}
function erpErr(r: { status: number; json: any }): string {
	const j = r.json ?? {};
	let m = String(j.exception ?? j.message ?? j.raw ?? '');
	if (j._server_messages) { try { m = (JSON.parse(j._server_messages) as string[]).map((s) => { try { return String((JSON.parse(s) as { message?: string }).message ?? s); } catch { return s; } }).join('; '); } catch { /* raw */ } }
	return `HTTP ${r.status}: ${m.slice(0, 220)}`;
}
async function erpExists(doctype: string, name: string): Promise<boolean> {
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}?fields=["name"]`);
	return r.status === 200;
}
async function erpCreate(doctype: string, fields: Record<string, unknown>): Promise<string> {
	const r = await erp('POST', `/api/resource/${encodeURIComponent(doctype)}`, fields);
	if (r.status >= 300) throw new Error(`${doctype} create: ${erpErr(r)}`);
	return String(r.json?.data?.name ?? '');
}
async function erpSetDocstatus(doctype: string, name: string, ds: 1 | 2): Promise<void> {
	const r = await erp('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, { docstatus: ds });
	if (r.status >= 300) throw new Error(`${doctype} docstatus=${ds}: ${erpErr(r)}`);
	const after = Number(r.json?.data?.docstatus ?? 0);
	if (after !== ds) throw new Error(`${doctype} ${name}: docstatus ожидали ${ds}, получили ${after}`);
}
async function binQty(code: string, wh: string): Promise<number> {
	const q = new URLSearchParams({ fields: JSON.stringify(['actual_qty']), filters: JSON.stringify([['item_code', '=', code], ['warehouse', '=', wh]]), limit_page_length: '0' });
	const r = await erp('GET', `/api/resource/Bin?${q}`);
	if (r.status !== 200) return 0;
	return (r.json?.data ?? []).reduce((a: number, b: any) => a + Number(b.actual_qty ?? 0), 0);
}

async function stockEntry(type: string, items: Array<Record<string, unknown>>): Promise<string> {
	const name = await erpCreate('Stock Entry', { stock_entry_type: type, company: COMPANY, items });
	await erpSetDocstatus('Stock Entry', name, 1);
	return name;
}

let pass = 0, fail = 0;
function check(label: string, got: number, want: number): void {
	const ok = Math.abs(got - want) < 1e-6;
	console.log(`  ${ok ? '✅' : '⛔'} ${label}: ${got} (ждали ${want})`);
	ok ? pass++ : fail++;
}

async function main(): Promise<void> {
	console.log(`ERP: ${ERP} | проба честного транзита ${QTY} шт: «${WH_A}» → «${TRANSIT}» → «${WH_B}»\n`);
	if (!ERP_AUTH) { console.error('Нет ERPNEXT_TOKEN'); process.exit(1); }

	if (!(await erpExists('Item Group', GROUP))) {
		await erpCreate('Item Group', { item_group_name: GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
		console.log(`+ группа «${GROUP}»`);
	}
	if (!(await erpExists('UOM', UOM))) await erpCreate('UOM', { uom_name: UOM });
	if (!(await erpExists('Item', ITEM))) {
		await erpCreate('Item', { item_code: ITEM, item_name: ITEM, item_group: GROUP, stock_uom: UOM, is_stock_item: 1 });
		console.log(`+ тест-товар «${ITEM}»`);
	}

	const created: string[] = [];
	try {
		console.log('\n1) Оприходование (Material Receipt) на склад А');
		created.push(await stockEntry('Material Receipt', [{ item_code: ITEM, qty: QTY, t_warehouse: WH_A, basic_rate: 100, uom: UOM }]));
		check(`склад А = ${QTY}`, await binQty(ITEM, WH_A), QTY);

		console.log('\n2) «Отгрузил» — Material Transfer: А → транзит');
		created.push(await stockEntry('Material Transfer', [{ item_code: ITEM, qty: QTY, s_warehouse: WH_A, t_warehouse: TRANSIT, uom: UOM }]));
		check('склад А = 0', await binQty(ITEM, WH_A), 0);
		check(`транзит = ${QTY}`, await binQty(ITEM, TRANSIT), QTY);

		console.log('\n3) «Получил» — Material Transfer: транзит → Б');
		created.push(await stockEntry('Material Transfer', [{ item_code: ITEM, qty: QTY, s_warehouse: TRANSIT, t_warehouse: WH_B, uom: UOM }]));
		check('транзит = 0', await binQty(ITEM, TRANSIT), 0);
		check(`склад Б = ${QTY}`, await binQty(ITEM, WH_B), QTY);
	} finally {
		console.log('\n4) Откат (cancel в обратном порядке) — чистим за собой');
		for (const name of [...created].reverse()) {
			try { await erpSetDocstatus('Stock Entry', name, 2); console.log(`  ↩ отменён ${name}`); }
			catch (e) { console.log(`  ⚠ не отменился ${name}: ${String(e).slice(0, 140)}`); }
		}
		console.log('  остатки после отката:');
		check('склад А', await binQty(ITEM, WH_A), 0);
		check('транзит', await binQty(ITEM, TRANSIT), 0);
		check('склад Б', await binQty(ITEM, WH_B), 0);
	}

	console.log(`\nИТОГ: ✅ ${pass}  ⛔ ${fail}`);
	process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
