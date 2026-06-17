/**
 * POC модели «покрывало»: партия-реализация как ЧИСТЫЙ ERPNext-документ с полем b24_deal_id.
 * Песочница (локальный ERPNext), боевой склад не трогается. Полный цикл:
 *  1) custom-поле b24_deal_id на Delivery Note (одноразово, идемпотентно)
 *  2) технический покупатель (headless: клиент живёт в Б24, тут — заглушка для документа)
 *  3) Delivery Note: кабель 18072 × 2 со склада «Железноводская, секция 34», b24_deal_id=36766
 *  4) ПРОВОДКА → остаток списался (Bin до/после)
 *  5) обратное чтение: «все партии сделки 36766» ОДНИМ запросом по b24_deal_id
 *     (то, ради чего сегодня были стены 1 и 2: привязка и склад — просто поля)
 * Запуск: npx tsx scripts/erp-poc-realization.ts
 */
const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token REDACTED';
const DEAL_ID = '36766';
const ITEM = '18072'; // Компьютерный кабель 5E (наружний) — есть на Железноводской
const QTY = 2;

async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await fetch(`${ERP}${path}`, {
		method,
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	});
	const text = await res.text();
	let json: any; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
	return { status: res.status, json };
}
function err(r: { status: number; json: any }): string {
	const j = r.json ?? {};
	let m = String(j.exception ?? j.message ?? j.raw ?? '');
	if (j._server_messages) { try { m = (JSON.parse(j._server_messages) as string[]).map((s) => { try { return String((JSON.parse(s) as { message?: string }).message ?? s); } catch { return s; } }).join('; '); } catch { /* raw */ } }
	return `HTTP ${r.status}: ${m.slice(0, 250)}`;
}
async function list(doctype: string, fields: string[], filters?: unknown[]): Promise<any[]> {
	const q = new URLSearchParams({ fields: JSON.stringify(fields), limit_page_length: '0' });
	if (filters) q.set('filters', JSON.stringify(filters));
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}?${q}`);
	if (r.status !== 200) throw new Error(`${doctype}: ${err(r)}`);
	return r.json.data ?? [];
}

(async () => {
	const company = (await list('Company', ['name', 'abbr'])).find((c) => !String(c.name).includes('Demo'))!;
	const WH = `Железноводская, секция 34 - ${company.abbr}`;
	console.log(`Компания: ${company.name}; склад: ${WH}`);

	console.log('\n1) custom-поле b24_deal_id на Delivery Note');
	const cfName = 'Delivery Note-b24_deal_id';
	const cf = await erp('GET', `/api/resource/Custom%20Field/${encodeURIComponent(cfName)}`);
	if (cf.status === 200) console.log('   уже есть');
	else {
		const r = await erp('POST', '/api/resource/Custom%20Field', {
			dt: 'Delivery Note', fieldname: 'b24_deal_id', label: 'B24 Deal', fieldtype: 'Data',
			insert_after: 'customer', in_standard_filter: 1, in_list_view: 1,
		});
		if (r.status >= 300) throw new Error(`custom field: ${err(r)}`);
		console.log('   создано');
	}

	console.log('\n2) технический покупатель');
	const CUSTOMER = 'Б24 Розница';
	const cu = await erp('GET', `/api/resource/Customer/${encodeURIComponent(CUSTOMER)}`);
	if (cu.status !== 200) {
		const r = await erp('POST', '/api/resource/Customer', { customer_name: CUSTOMER, customer_type: 'Individual' });
		if (r.status >= 300) throw new Error(`customer: ${err(r)}`);
		console.log('   создан');
	} else console.log('   уже есть');

	const binBefore = (await list('Bin', ['actual_qty'], [['item_code', '=', ITEM], ['warehouse', '=', WH]]))[0];
	console.log(`\n3) остаток ${ITEM} @ ${WH} ДО: ${binBefore?.actual_qty ?? 0}`);

	console.log(`4) Delivery Note: ${ITEM} × ${QTY}, b24_deal_id=${DEAL_ID}`);
	const dn = await erp('POST', '/api/resource/Delivery%20Note', {
		company: company.name,
		customer: CUSTOMER,
		set_posting_time: 1,
		posting_date: new Date().toISOString().slice(0, 10),
		b24_deal_id: DEAL_ID,
		items: [{ item_code: ITEM, qty: QTY, warehouse: WH, rate: 47 }],
	});
	if (dn.status >= 300) throw new Error(`DN create: ${err(dn)}`);
	const dnName = dn.json.data.name as string;
	console.log(`   черновик ${dnName}`);

	console.log('5) ПРОВОДКА (списание)');
	const sub = await erp('PUT', `/api/resource/Delivery%20Note/${encodeURIComponent(dnName)}`, { docstatus: 1 });
	if (sub.status >= 300 || Number(sub.json?.data?.docstatus) !== 1) throw new Error(`DN submit: ${err(sub)}`);
	console.log('   проведена ✅');

	const binAfter = (await list('Bin', ['actual_qty'], [['item_code', '=', ITEM], ['warehouse', '=', WH]]))[0];
	console.log(`6) остаток ПОСЛЕ: ${binAfter?.actual_qty ?? 0} (ожидали ${Number(binBefore?.actual_qty ?? 0) - QTY})`);

	console.log(`\n7) ОБРАТНОЕ ЧТЕНИЕ: партии сделки ${DEAL_ID} одним запросом`);
	const parts = await list('Delivery Note', ['name', 'posting_date', 'docstatus', 'b24_deal_id', 'grand_total'], [['b24_deal_id', '=', DEAL_ID]]);
	for (const p of parts) console.log(`   ${p.name}: дата ${p.posting_date}, статус ${p.docstatus === 1 ? 'проведена' : 'черновик'}, сумма ${p.grand_total}`);
	const items = await list('Delivery Note Item', ['parent', 'item_code', 'item_name', 'qty', 'warehouse'], [['parent', '=', parts[0]?.name ?? '']]);
	for (const it of items) console.log(`     ${it.item_code} «${String(it.item_name).slice(0, 40)}» × ${it.qty} со склада ${it.warehouse}`);

	console.log('\n✅ POC ПРОЙДЕН: привязка к сделке и склад — обычные поля, никаких стен.');
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
