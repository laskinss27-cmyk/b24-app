/**
 * МИГРАЦИЯ истории реализаций Б24 → ERPNext (этап выноса склада, «покрывало»).
 *
 * Вариант А (решение Сергея 2026-06-15): реализации переносятся как ЗАПИСИ, а НЕ как
 * складские движения. Каждая отгрузка → Delivery Note ЧЕРНОВИК (docstatus 0, НЕ проводим).
 * Почему так — две стены Б24:
 *   1. У проведённой отгрузки REST не отдаёт склад списания (резерв очищен) — настоящий
 *      склад истории неизвестен. Склад в строках — ПЛЕЙСХОЛДЕР, только для валидации схемы.
 *   2. Ежечасный синк держит ядро = текущие остатки Б24 (уже учитывают все прошлые отгрузки).
 *      Проведи мы эти DN — остаток списался бы ПОВТОРНО, сверка-в-ноль сломалась бы.
 * Раз документ не проводим — остаток НЕ двигается; ценность = история + привязка к сделке
 * (b24_deal_id) для окна «Реализации↔сделки», читаемого из ядра.
 *
 * ИДЕМПОТЕНТНО: ключ — custom-поле b24_shipment_id (отгрузка уникальна; у сделки партий много).
 * Повторный запуск догоняет дельту, существующие пропускает.
 *
 * Запуск:  npx tsx scripts/erp-migrate-realizations.ts --dry     (посчитать, ничего не писать)
 *          npx tsx scripts/erp-migrate-realizations.ts --setup   (custom-поля Delivery Note)
 *          npx tsx scripts/erp-migrate-realizations.ts --run     (залить черновики)
 *          npx tsx scripts/erp-migrate-realizations.ts --check   (сверка Б24 vs ядро)
 * env: ERPNEXT_URL, ERPNEXT_TOKEN, DEV_WEBHOOK, LOCAL_PROXY.
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Б24 читаем ЧЕРЕЗ CURL с -x прокси (напрямую Битрикс не отвечает, undici ProxyAgent даёт
// необъяснимые таймауты — выстрадано в catalog/clients). ERPNext (localhost) — undici напрямую.
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const localAgent = new Agent();
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WEBHOOK) { console.error('DEV_WEBHOOK нет'); process.exit(1); }

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry') || args.size === 0;
// --limit=N: залить только первые N (для проверки payload перед полным прогоном).
const LIMIT = (() => { const a = process.argv.find((x) => x.startsWith('--limit=')); return a ? Number(a.slice(8)) : Infinity; })();

// ── Б24 REST через curl (системный прокси), с ретраями ──────────────────────────
async function b24curl<T>(method: string, body: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 5; a++) {
		try {
			const { stdout } = await execFileP('curl.exe', [
				'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '90',
				'-H', 'Content-Type: application/json',
				'-d', JSON.stringify(body),
				`${WEBHOOK}/${method}.json`,
			], { maxBuffer: 128 * 1024 * 1024 });
			const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
			return json.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

/** Сериализация params в query-строку для batch (nested: filter[ID]=1, select[0]=id). Порт из b24/client.ts. */
function toQuery(params: Record<string, unknown>, prefix = ''): string {
	const parts: string[] = [];
	for (const [key, value] of Object.entries(params)) {
		const k = prefix ? `${prefix}[${key}]` : key;
		if (value === null || value === undefined) continue;
		if (Array.isArray(value)) {
			value.forEach((item, i) => {
				if (typeof item === 'object' && item !== null) parts.push(toQuery(item as Record<string, unknown>, `${k}[${i}]`));
				else parts.push(`${encodeURIComponent(`${k}[${i}]`)}=${encodeURIComponent(String(item))}`);
			});
		} else if (typeof value === 'object') {
			parts.push(toQuery(value as Record<string, unknown>, k));
		} else {
			parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(value))}`);
		}
	}
	return parts.join('&');
}

/** Батч-вызов Б24 через curl: до 50 команд за HTTP-запрос, авто-чанк, ключи сохраняются. */
async function b24batch(calls: Record<string, { method: string; params?: Record<string, unknown> }>): Promise<Record<string, unknown>> {
	const entries = Object.entries(calls);
	const out: Record<string, unknown> = {};
	for (let i = 0; i < entries.length; i += 50) {
		const cmd: Record<string, string> = {};
		for (const [key, { method, params }] of entries.slice(i, i + 50)) {
			const q = params ? toQuery(params) : '';
			cmd[key] = q ? `${method}?${q}` : method;
		}
		const res = await b24curl<{ result: Record<string, unknown>; result_error: Record<string, unknown> }>('batch', { halt: 0, cmd });
		Object.assign(out, res.result);
		const errs = Object.entries(res.result_error ?? {});
		if (errs.length) console.log(`  ⚠ батч-ошибки: ${errs.slice(0, 3).map(([k, e]) => `${k}:${JSON.stringify(e).slice(0, 80)}`).join(' | ')}${errs.length > 3 ? ` (+${errs.length - 3})` : ''}`);
	}
	return out;
}

// ── ERPNext REST (undici, localhost напрямую) ───────────────────────────────────
const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token 75a1085fa14560a:df3408f48a7428f';

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
async function erpList(doctype: string, fields: string[], filters?: unknown[]): Promise<Array<Record<string, unknown>>> {
	const q = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: '0' });
	if (filters) q.set('filters', JSON.stringify(filters));
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}?${q}`);
	if (r.status !== 200) throw new Error(`${doctype} list: ${erpErr(r)}`);
	return (r.json?.data ?? []) as Array<Record<string, unknown>>;
}
async function erpGet(doctype: string, name: string): Promise<Record<string, unknown> | null> {
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
	return r.status === 200 ? (r.json?.data as Record<string, unknown>) : null;
}
async function erpCreate(doctype: string, fields: Record<string, unknown>): Promise<string> {
	const r = await erp('POST', `/api/resource/${encodeURIComponent(doctype)}`, fields);
	if (r.status >= 300) throw new Error(`${doctype} create: ${erpErr(r)}`);
	return String(r.json?.data?.name ?? '');
}

const DEAL_FIELD = 'b24_deal_id';
const SHIP_FIELD = 'b24_shipment_id';
const ACCOUNT_FIELD = 'b24_account';
const CLIENT_FIELD = 'b24_client';
const TECH_CUSTOMER = 'Б24 Розница';

interface Ctx { company: string; abbr: string; placeholderWh: string; }
let ctxCache: Ctx | null = null;

async function erpContext(): Promise<Ctx> {
	if (ctxCache) return ctxCache;
	const companies = await erpList('Company', ['name', 'abbr']);
	const real = companies.find((c) => !String(c['name']).includes('Demo')) ?? companies[0];
	if (!real) throw new Error('ERPNext: нет ни одной компании');
	const company = String(real['name']);
	// Плейсхолдер-склад: любой лист-склад компании. Документы НЕ проводим — склад чисто для схемы.
	const whs = await erpList('Warehouse', ['name'], [['company', '=', company], ['is_group', '=', 0]]);
	if (!whs.length) throw new Error(`нет складов у компании «${company}»`);
	ctxCache = { company, abbr: String(real['abbr']), placeholderWh: String(whs[0]!['name']) };
	return ctxCache;
}

/** Идемпотентно: custom-поля Delivery Note (ключ отгрузки + витринные номер/клиент + сделка). */
async function ensureFields(): Promise<void> {
	const want = [
		{ fieldname: SHIP_FIELD, label: 'B24 Shipment', unique: 1 },
		{ fieldname: DEAL_FIELD, label: 'B24 Deal', unique: 0 },
		{ fieldname: ACCOUNT_FIELD, label: 'B24 Account', unique: 0 },
		{ fieldname: CLIENT_FIELD, label: 'B24 Client', unique: 0 },
	];
	for (const f of want) {
		const cfName = `Delivery Note-${f.fieldname}`;
		if (await erpGet('Custom Field', cfName)) continue;
		await erpCreate('Custom Field', {
			dt: 'Delivery Note', fieldname: f.fieldname, label: f.label, fieldtype: 'Data',
			unique: f.unique, insert_after: 'customer', in_standard_filter: 1, in_list_view: 1,
		});
		console.log(`  + Custom Field ${cfName}${f.unique ? ' (unique)' : ''}`);
	}
}

// ── Чтение реализаций из Б24 ─────────────────────────────────────────────────────
interface RealLine { productId: number; qty: number; rate: number; }
interface Realization {
	shipmentId: number;
	account: string;
	date: string;          // YYYY-MM-DD
	dealId: number | null;
	client: string;
	lines: RealLine[];
}

const CRM_PR_RE = /^crm_pr_(\d+)$/;

async function readRealizations(): Promise<Realization[]> {
	// 1) Все проведённые отгрузки (пагинация по 50, новые сверху — порядок не важен).
	const ships: Array<Record<string, unknown>> = [];
	for (let start = 0; ; start += 50) {
		const page = await b24curl<{ shipments?: Array<Record<string, unknown>> }>('sale.shipment.list', {
			select: ['id', 'orderId', 'accountNumber', 'dateDeducted', 'dateInsert', 'responsibleId'],
			filter: { deducted: 'Y', system: 'N' }, order: { id: 'DESC' }, start,
		});
		const arr = page?.shipments ?? [];
		ships.push(...arr);
		if (arr.length < 50) break;
	}
	console.log(`  отгрузок (проведённых): ${ships.length}`);
	const orderIds = [...new Set(ships.map((s) => Number(s['orderId'])).filter((x) => x > 0))];

	// 2) Заказы: корзина (basketItemId → {productId, price}) + первый crm_pr_ (rowId сделки).
	const basketByOrder = new Map<number, Map<number, { productId: number; price: number }>>();
	const dealRowByOrder = new Map<number, number>();
	{
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of orderIds) calls[`o${id}`] = { method: 'sale.order.get', params: { id } };
		const res = await b24batch(calls);
		for (const id of orderIds) {
			const order = (res[`o${id}`] as { order?: Record<string, unknown> } | undefined)?.order;
			const items = (order?.['basketItems'] as Array<Record<string, unknown>>) ?? [];
			const map = new Map<number, { productId: number; price: number }>();
			for (const b of items) {
				map.set(Number(b['id']), { productId: Number(b['productId']), price: Number(b['price'] ?? 0) });
				const m = CRM_PR_RE.exec(String(b['xmlId'] ?? ''));
				if (m && !dealRowByOrder.has(id)) dealRowByOrder.set(id, Number(m[1]));
			}
			basketByOrder.set(id, map);
		}
	}

	// 3) Клиент по свойствам заказа (физлицо ФИО / контакт юрлица / компания).
	const clientByOrder = new Map<number, string>();
	{
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of orderIds) calls[`p${id}`] = { method: 'sale.propertyvalue.list', params: { filter: { orderId: id } } };
		const res = await b24batch(calls);
		for (const id of orderIds) {
			const props = (res[`p${id}`] as { propertyValues?: Array<Record<string, unknown>> } | undefined)?.propertyValues ?? [];
			let person = '', company = '', contact = '';
			for (const p of props) {
				const code = String(p['code'] ?? ''); const name = String(p['name'] ?? '');
				const val = p['value'] == null ? '' : String(p['value']);
				if (!val) continue;
				if (code === 'COMPANY') company = val;
				else if (code === 'CONTACT_PERSON') contact = val;
				else if (code === 'FIO' || name === 'Имя Фамилия') person = val;
			}
			clientByOrder.set(id, person || contact || company);
		}
	}

	// 4) rowId → сделка (ownerType='D').
	const rowIds = [...new Set([...dealRowByOrder.values()])];
	const dealByRow = new Map<number, number>();
	if (rowIds.length) {
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of rowIds) calls[`r${id}`] = { method: 'crm.item.productrow.get', params: { id } };
		const res = await b24batch(calls);
		for (const id of rowIds) {
			const pr = (res[`r${id}`] as { productRow?: Record<string, unknown> } | undefined)?.productRow;
			if (pr && String(pr['ownerType']) === 'D') dealByRow.set(id, Number(pr['ownerId']));
		}
	}

	// 5) Строки каждой отгрузки (basketId+quantity) → {productId, qty, rate}.
	const linesByShip = new Map<number, RealLine[]>();
	{
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const s of ships) calls[`s${s['id']}`] = { method: 'sale.shipmentitem.list', params: { filter: { orderDeliveryId: Number(s['id']) } } };
		const res = await b24batch(calls);
		for (const s of ships) {
			const sid = Number(s['id']);
			const basket = basketByOrder.get(Number(s['orderId']));
			const items = (res[`s${sid}`] as { shipmentItems?: Array<Record<string, unknown>> } | undefined)?.shipmentItems ?? [];
			const lines: RealLine[] = [];
			for (const it of items) {
				const b = basket?.get(Number(it['basketId']));
				if (!b || !Number.isInteger(b.productId) || b.productId <= 0) continue;
				lines.push({ productId: b.productId, qty: Number(it['quantity'] ?? 0), rate: b.price });
			}
			linesByShip.set(sid, lines);
		}
	}

	// 6) Сборка.
	return ships.map((s) => {
		const sid = Number(s['id']); const oid = Number(s['orderId']);
		const rowId = dealRowByOrder.get(oid);
		const dealId = rowId != null ? dealByRow.get(rowId) ?? null : null;
		return {
			shipmentId: sid,
			account: String(s['accountNumber'] ?? sid),
			date: String(s['dateDeducted'] ?? s['dateInsert'] ?? '').slice(0, 10),
			dealId: dealId && dealId > 0 ? dealId : null,
			client: clientByOrder.get(oid) ?? '',
			lines: linesByShip.get(sid) ?? [],
		};
	});
}

// ── main ────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log(`ERPNext: ${ERP} | режим: ${[...args].join(' ') || '--dry'}`);
	const ctx = await erpContext();
	console.log(`Компания: ${ctx.company} | плейсхолдер-склад: ${ctx.placeholderWh}`);

	console.log('\nЧитаю Б24: отгрузки, заказы, строки, сделки…');
	const reals = await readRealizations();
	const withDeal = reals.filter((r) => r.dealId != null).length;
	const withLines = reals.filter((r) => r.lines.length > 0).length;
	const totalLines = reals.reduce((a, r) => a + r.lines.length, 0);
	console.log(`  реализаций: ${reals.length}; со сделкой: ${withDeal}; без сделки: ${reals.length - withDeal}`);
	console.log(`  со строками: ${withLines}; всего строк: ${totalLines}; пустых (без строк): ${reals.length - withLines}`);

	if (DRY) { console.log('\nDRY: ничего не пишу. Запусти с --setup, затем --run / --check.'); return; }

	if (args.has('--setup')) {
		console.log('\n— SETUP custom-полей —');
		await ensureFields();
		// тех-розница (на случай чистой площадки)
		if (!(await erpGet('Customer', TECH_CUSTOMER))) {
			await erpCreate('Customer', { customer_name: TECH_CUSTOMER, customer_type: 'Individual' });
			console.log(`  + Customer «${TECH_CUSTOMER}»`);
		}
		console.log('  ✅ поля готовы');
	}

	if (args.has('--run')) {
		console.log('\n— ЗАЛИВКА черновиков Delivery Note —');
		await ensureFields(); // безопасно: вдруг --run без --setup
		// идемпотентность: что уже залито
		const existing = new Set(
			(await erpList('Delivery Note', ['name', SHIP_FIELD], [[SHIP_FIELD, '!=', '']]))
				.map((d) => String(d[SHIP_FIELD])),
		);
		console.log(`  в ядре уже: ${existing.size}`);
		let created = 0, skipped = 0, empty = 0, failed = 0;
		for (const r of reals) {
			if (created >= LIMIT) { console.log(`  (стоп по --limit=${LIMIT})`); break; }
			if (existing.has(String(r.shipmentId))) { skipped++; continue; }
			if (!r.lines.length) { empty++; continue; } // нет строк — Delivery Note создать нельзя
			try {
				await erpCreate('Delivery Note', {
					company: ctx.company,
					customer: TECH_CUSTOMER,
					set_posting_time: 1,
					posting_date: r.date,
					[SHIP_FIELD]: String(r.shipmentId),
					[ACCOUNT_FIELD]: r.account,
					[CLIENT_FIELD]: r.client.slice(0, 140),
					...(r.dealId ? { [DEAL_FIELD]: String(r.dealId) } : {}),
					// docstatus НЕ трогаем → остаётся черновиком (0), остаток НЕ двигается.
					items: r.lines.map((l) => ({
						item_code: String(l.productId),
						qty: l.qty,
						rate: l.rate,
						warehouse: ctx.placeholderWh, // плейсхолдер: настоящий склад истории Б24 не отдаёт
					})),
				});
				created++;
				if (created % 50 === 0) console.log(`  …создано ${created}`);
			} catch (e) {
				failed++;
				if (failed <= 10) console.log(`  ⛔ отгрузка ${r.account} (#${r.shipmentId}): ${String(e).slice(0, 160)}`);
			}
		}
		console.log(`  ИТОГ: создано ${created}, пропущено (уже есть) ${skipped}, пустых (без строк) ${empty}, ошибок ${failed}`);
	}

	if (args.has('--check')) {
		console.log('\n— СВЕРКА Б24 vs ядро —');
		const dns = await erpList('Delivery Note', ['name', SHIP_FIELD, DEAL_FIELD], [[SHIP_FIELD, '!=', '']]);
		const erpShipments = new Set(dns.map((d) => String(d[SHIP_FIELD])));
		const b24NonEmpty = reals.filter((r) => r.lines.length > 0);
		const missing = b24NonEmpty.filter((r) => !erpShipments.has(String(r.shipmentId)));
		const dnWithDeal = dns.filter((d) => String(d[DEAL_FIELD] ?? '')).length;
		console.log(`  Б24 реализаций со строками: ${b24NonEmpty.length}`);
		console.log(`  DN в ядре (по b24_shipment_id): ${erpShipments.size}; из них со сделкой: ${dnWithDeal}`);
		console.log(`  не залито: ${missing.length}${missing.length ? ` (напр. ${missing.slice(0, 5).map((r) => r.account).join(', ')})` : ''}`);
		console.log(missing.length === 0 ? '  ✅ ВСЁ ЗАЛИТО' : '  ⚠ есть незалитые — прогони --run');
	}

	console.log('\nГОТОВО');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
