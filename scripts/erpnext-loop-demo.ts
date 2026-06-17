/**
 * ПРОБА полного круга: Битрикс → ERPNext (товары) → сделка в ERPNext → задача в Битриксе.
 * Запуск: npx tsx scripts/erpnext-loop-demo.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError, type BatchCall } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const ERP = 'http://localhost:8080';
const ERP_AUTH = 'token REDACTED';
const N_PRODUCTS = 20;
const ITEM_GROUP = 'Каталог Битрикс';
const RESPONSIBLE_ID = 1858; // Сергей

async function erp(method: string, path: string, body?: unknown): Promise<{ ok: boolean; data?: any; error?: string }> {
	const res = await fetch(`${ERP}${path}`, {
		method,
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	if (res.ok) { try { return { ok: true, data: JSON.parse(text).data }; } catch { return { ok: true }; } }
	let msg = text.slice(0, 250);
	try { const j = JSON.parse(text); msg = String(j._server_messages ?? j.exception ?? j.message ?? msg).slice(0, 250); } catch { /* raw */ }
	return { ok: false, error: `HTTP ${res.status}: ${msg}` };
}

async function main(): Promise<void> {
	// ── 0) дефолтная компания ERPNext ───────────────────────────────────────────
	const comp = await erp('GET', '/api/resource/Company?limit_page_length=1');
	const company = comp.ok && comp.data?.[0]?.name;
	console.log('0) компания ERPNext:', company || '(не нашёл — SO попробую без неё)');

	// ── 1) группа товаров ───────────────────────────────────────────────────────
	const grpExists = await erp('GET', `/api/resource/Item Group/${encodeURIComponent(ITEM_GROUP)}`);
	if (!grpExists.ok) {
		const g = await erp('POST', '/api/resource/Item Group', { item_group_name: ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
		console.log('1) группа товаров:', g.ok ? 'создана' : `ошибка ${g.error}`);
	} else console.log('1) группа товаров: уже есть');

	// ── 2) тащим товары из Битрикса + цены ───────────────────────────────────────
	console.log('2) читаю товары из Битрикса (catalog.product.list, iblock 24)…');
	const prods = await b24.call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		filter: { iblockId: 24 }, select: ['id', 'iblockId', 'name'], order: { id: 'DESC' },
	});
	const sample = (prods?.products ?? []).slice(0, N_PRODUCTS);
	// цены батчем (BASE, group 2)
	const calls: Record<string, BatchCall> = {};
	for (const p of sample) calls[`pr${p['id']}`] = { method: 'catalog.price.list', params: { filter: { productId: Number(p['id']), catalogGroupId: 2 }, select: ['productId', 'price'] } };
	const priceRes = await b24.callBatch(calls);
	const priceOf = (id: number): number => Number((priceRes.result[`pr${id}`] as { prices?: Array<Record<string, unknown>> } | undefined)?.prices?.[0]?.['price'] ?? 0);
	console.log(`   товаров: ${sample.length}`);

	// ── 3) создаём Items в ERPNext ───────────────────────────────────────────────
	let made = 0; const items: { code: string; price: number }[] = [];
	for (const p of sample) {
		const id = Number(p['id']);
		const code = `B24-${id}`;
		const price = priceOf(id);
		const r = await erp('POST', '/api/resource/Item', {
			item_code: code, item_name: String(p['name'] ?? code).slice(0, 140),
			item_group: ITEM_GROUP, stock_uom: 'Nos', is_stock_item: 0, standard_rate: price,
		});
		if (r.ok) { made++; items.push({ code, price }); }
		else if (r.error?.includes('DuplicateEntry') || r.error?.includes('exists')) { items.push({ code, price }); }
		else console.log(`   ⛔ Item ${code}: ${r.error}`);
	}
	console.log(`3) Items в ERPNext: создано/готово ${items.length} (новых ${made})`);
	if (!items.length) { console.log('нет товаров — стоп'); return; }

	// ── 4) клиент ────────────────────────────────────────────────────────────────
	const custName = 'Клиент демо (из ERPNext)';
	let customer = custName;
	const c = await erp('POST', '/api/resource/Customer', { customer_name: custName });
	if (c.ok) { customer = c.data?.name ?? custName; console.log('4) клиент создан:', customer); }
	else { console.log('4) клиент:', c.error, '→ пробую существующего'); const ex = await erp('GET', '/api/resource/Customer?limit_page_length=1'); customer = ex.data?.[0]?.name ?? custName; console.log('   беру:', customer); }

	// ── 5) СДЕЛКА (Sales Order) с 3 товарами ─────────────────────────────────────
	const dd = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
	const soItems = items.slice(0, 3).map((it) => ({ item_code: it.code, qty: 1, rate: it.price, delivery_date: dd }));
	const soBody: Record<string, unknown> = { customer, delivery_date: dd, items: soItems };
	if (company) soBody['company'] = company;
	const so = await erp('POST', '/api/resource/Sales Order', soBody);
	if (!so.ok) { console.log('5) ⛔ сделка (Sales Order):', so.error); return; }
	const soName = so.data?.name as string;
	const soTotal = so.data?.grand_total ?? so.data?.total;
	console.log(`5) СДЕЛКА создана в ERPNext: ${soName}, сумма ${soTotal}`);

	// ── 6) ЗАДАЧА в Битриксе по этой сделке ──────────────────────────────────────
	try {
		const task = await b24.call<{ task?: { id?: number } }>('tasks.task.add', {
			fields: {
				TITLE: `Монтаж по заказу ${soName} (из ERPNext)`,
				RESPONSIBLE_ID,
				DESCRIPTION: `Заказ ${soName} создан в ERPNext. Позиций: ${soItems.length}. Сумма: ${soTotal}. Это автозадача из внешней складской системы.`,
			},
		});
		console.log(`6) ✅ ЗАДАЧА в Битриксе создана: ID ${task?.task?.id} — «Монтаж по заказу ${soName}»`);
	} catch (e) {
		console.log('6) ⛔ задача в Битриксе:', e instanceof B24ApiError ? `${e.code}: ${e.description}` : String(e));
	}

	console.log('\n=== КРУГ ЗАМКНУТ ===');
	console.log(`Битрикс → ERPNext: ${items.length} товаров`);
	console.log(`ERPNext сделка: ${soName} (смотри ${ERP}/app/sales-order/${encodeURIComponent(soName)})`);
	console.log(`ERPNext → Битрикс: задача на монтаж`);
}
main().catch((e) => console.error('FATAL', e instanceof B24ApiError ? e.message : e));
