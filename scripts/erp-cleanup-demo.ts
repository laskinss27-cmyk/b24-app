/**
 * СНОС демо-компании «Умный дом (Demo)» из локального ERPNext (уборка перед
 * инвентаризацией, согласовано 2026-06-12). Б24 НЕ трогается.
 * Порядок: Transaction Deletion Record (фоновая зачистка транзакций компании)
 * → демо-Items SKU% → демо-склады → сама компания.
 *
 * Запуск:  npx tsx scripts/erp-cleanup-demo.ts          (показать, что нашлось)
 *          npx tsx scripts/erp-cleanup-demo.ts --apply  (снести)
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';

const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token REDACTED';
const DEMO = 'Умный дом (Demo)';
const localAgent = new Agent();
const APPLY = process.argv.includes('--apply');

async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await undiciRequest(`${ERP}${path}`, {
		method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		dispatcher: localAgent,
		headersTimeout: 120_000, bodyTimeout: 120_000,
	});
	const text = await res.body.text();
	let json: any = null;
	try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
	return { status: res.statusCode, json };
}
function erpErr(r: { status: number; json: any }): string {
	const j = r.json ?? {};
	let m = String(j.exception ?? j.message ?? j.raw ?? '');
	if (j._server_messages) { try { m = (JSON.parse(j._server_messages) as string[]).map((s) => { try { return String((JSON.parse(s) as { message?: string }).message ?? s); } catch { return s; } }).join('; '); } catch { /* raw */ } }
	return `HTTP ${r.status}: ${m.slice(0, 300)}`;
}
async function list(doctype: string, filters: unknown[], fields = ['name']): Promise<string[]> {
	const q = new URLSearchParams({ fields: JSON.stringify(fields), filters: JSON.stringify(filters), limit_page_length: '0' });
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}?${q}`);
	if (r.status !== 200) throw new Error(`${doctype} list: ${erpErr(r)}`);
	return (r.json?.data ?? []).map((d: any) => String(d.name));
}
async function del(doctype: string, name: string): Promise<void> {
	const r = await erp('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`);
	if (r.status >= 300) throw new Error(`${doctype} «${name}»: ${erpErr(r)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
	const companies = await list('Company', []);
	if (!companies.includes(DEMO)) { console.log(`Компании «${DEMO}» нет — сносить нечего. Компании: ${companies.join(', ')}`); return; }

	const demoWh = await list('Warehouse', [['company', '=', DEMO]]);
	const demoItems = await list('Item', [['item_code', 'like', 'SKU0%']]);
	const sle = await list('Stock Ledger Entry', [['company', '=', DEMO]]);
	console.log(`Нашлось: складов ${demoWh.length}, демо-Items ${demoItems.length} (${demoItems.join(', ')}), SLE-транзакций ${sle.length}`);
	if (!APPLY) { console.log('\nДемо-режим. Снести: --apply'); return; }

	// 0) трупы прошлых попыток: Failed TDR снять с проведения и удалить
	for (const old of await list('Transaction Deletion Record', [['status', '=', 'Failed']])) {
		await erp('PUT', `/api/resource/Transaction Deletion Record/${encodeURIComponent(old)}`, { docstatus: 2 });
		try { await del('Transaction Deletion Record', old); console.log(`  − старый TDR ${old}`); }
		catch (e) { console.log(`  ⚠ старый TDR ${old} не удалился: ${String(e).slice(0, 120)}`); }
	}

	// 1) транзакции компании — штатным Transaction Deletion Record (асинхронный).
	// ВАЖНО: до submit надо заполнить список «Для удаления» — в UI это кнопка,
	// по REST — whitelisted-метод generate_to_delete_list (иначе TDR падает Failed).
	if (sle.length) {
		console.log('Создаю Transaction Deletion Record…');
		const tdr = await erp('POST', '/api/resource/Transaction Deletion Record', { company: DEMO });
		if (tdr.status >= 300) throw new Error(`TDR create: ${erpErr(tdr)}`);
		const name = String(tdr.json?.data?.name);
		const gen = await erp('POST', '/api/method/run_doc_method', { dt: 'Transaction Deletion Record', dn: name, method: 'generate_to_delete_list' });
		if (gen.status >= 300) throw new Error(`TDR generate_to_delete_list: ${erpErr(gen)}`);
		console.log(`  список «Для удаления»: ${JSON.stringify(gen.json?.message ?? gen.json).slice(0, 120)}`);
		const sub = await erp('PUT', `/api/resource/Transaction Deletion Record/${encodeURIComponent(name)}`, { docstatus: 1 });
		if (sub.status >= 300) throw new Error(`TDR submit: ${erpErr(sub)}`);
		// фоновая джоба: ждём терминального статуса (Failed — тоже терминальный!)
		for (let i = 0; i < 60; i++) {
			await sleep(5000);
			const st = await erp('GET', `/api/resource/Transaction Deletion Record/${encodeURIComponent(name)}?fields=["status","error_log"]`);
			const status = String(st.json?.data?.status ?? '?');
			const left = (await list('Stock Ledger Entry', [['company', '=', DEMO]])).length;
			console.log(`  …TDR ${status}, SLE осталось ${left}`);
			if (status === 'Failed') { console.log(`  ⛔ TDR упал: ${String(st.json?.data?.error_log ?? '').slice(0, 400)}`); break; }
			if (status === 'Completed' || left === 0) break;
		}
	}

	// 2) демо-Items (после зачистки транзакций ссылок не осталось)
	for (const it of demoItems) {
		try { await del('Item', it); console.log(`  − Item ${it}`); }
		catch (e) { console.log(`  ⛔ Item ${it}: ${String(e).slice(0, 200)}`); }
	}

	// 3) склады демо-компании (дочерние раньше родителей: сортировка по длине пути не нужна —
	//    у ERPNext дерево, удаляем не-группы, потом группы)
	const whDocs: Array<{ name: string; isGroup: number }> = [];
	for (const w of demoWh) {
		const r = await erp('GET', `/api/resource/Warehouse/${encodeURIComponent(w)}?fields=["name","is_group"]`);
		whDocs.push({ name: w, isGroup: Number(r.json?.data?.is_group ?? 0) });
	}
	for (const w of [...whDocs.filter((x) => !x.isGroup), ...whDocs.filter((x) => x.isGroup)]) {
		try { await del('Warehouse', w.name); console.log(`  − Warehouse ${w.name}`); }
		catch (e) { console.log(`  ⛔ Warehouse ${w.name}: ${String(e).slice(0, 200)}`); }
	}

	// 4) сама компания. Сначала отвязать от Global Defaults (дефолт инсталляции — ДЕМО,
	//    та самая граблина) — иначе LinkExistsError.
	const main = (await list('Company', [['name', '!=', DEMO]]))[0];
	const gd = await erp('PUT', '/api/resource/Global Defaults/Global Defaults', { default_company: main });
	if (gd.status >= 300) console.log(`  ⚠ Global Defaults: ${erpErr(gd)}`);
	else console.log(`  ✓ дефолтная компания → «${main}»`);
	try { await del('Company', DEMO); console.log(`  − Company «${DEMO}»`); }
	catch (e) { console.log(`  ⛔ Company: ${String(e).slice(0, 250)}`); }

	const after = await list('Company', []);
	console.log(`\nКомпании после уборки: ${after.join(', ')}`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
