/**
 * ПРОБА интеграции: читаем лидов из Битрикса (REST) → создаём их в ERPNext (REST API).
 * ERPNext локально на http://localhost:8080. Берём первые ~25 лидов.
 * Запуск: npx tsx scripts/bitrix-to-erpnext-leads.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK нет'); process.exit(1); }
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const ERP = 'http://localhost:8080';
const ERP_AUTH = 'token REDACTED';
const LIMIT = 25;

function firstMulti(v: unknown): string {
	if (Array.isArray(v) && v.length) {
		const item = v[0] as Record<string, unknown>;
		return String(item['VALUE'] ?? '');
	}
	return '';
}

async function erpPost(doctype: string, fields: Record<string, unknown>): Promise<{ ok: boolean; name?: string; error?: string }> {
	const res = await fetch(`${ERP}/api/resource/${doctype}`, {
		method: 'POST',
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		body: JSON.stringify(fields),
	});
	const text = await res.text();
	if (res.ok) {
		try { return { ok: true, name: (JSON.parse(text).data?.name as string) }; }
		catch { return { ok: true }; }
	}
	// вытащим понятное сообщение об ошибке ERPNext
	let msg = text.slice(0, 200);
	try { const j = JSON.parse(text); msg = String(j._server_messages ?? j.exception ?? j.message ?? msg); } catch { /* raw */ }
	return { ok: false, error: `HTTP ${res.status}: ${msg.slice(0, 200)}` };
}

async function main(): Promise<void> {
	console.log('1) читаю лидов из Битрикса (crm.lead.list)…');
	const leads = await b24.call<Array<Record<string, unknown>>>('crm.lead.list', {
		select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'COMPANY_TITLE', 'PHONE', 'EMAIL', 'SOURCE_ID', 'STATUS_ID'],
		order: { ID: 'DESC' },
	}) ?? [];
	console.log(`   получено: ${leads.length}, беру первые ${LIMIT}`);
	const sample = leads.slice(0, LIMIT);

	let ok = 0, fail = 0;
	for (const l of sample) {
		const name = `${l['NAME'] ?? ''} ${l['LAST_NAME'] ?? ''}`.trim() || String(l['TITLE'] ?? '') || String(l['COMPANY_TITLE'] ?? '') || `Лид ${l['ID']}`;
		const fields: Record<string, unknown> = { lead_name: name };
		const company = String(l['COMPANY_TITLE'] ?? '');
		const email = firstMulti(l['EMAIL']);
		const mobile = firstMulti(l['PHONE']);
		if (company) fields['company_name'] = company;
		if (email) fields['email_id'] = email;
		if (mobile) fields['mobile_no'] = mobile;
		const r = await erpPost('Lead', fields);
		if (r.ok) { ok++; console.log(`   ✅ #${l['ID']} «${name}» → ERPNext ${r.name ?? ''}`); }
		else { fail++; console.log(`   ⛔ #${l['ID']} «${name}» → ${r.error}`); }
	}
	console.log(`\nИТОГ: создано ${ok}, ошибок ${fail}`);
}
main().catch((e) => console.error('FATAL', e instanceof B24ApiError ? e.message : e));
