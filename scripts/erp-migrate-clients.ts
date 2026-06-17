/**
 * МИГРАЦИЯ клиентов Б24 → ERPNext (домашний этап выноса склада, продолжение каталога).
 * Решения (Сергей 2026-06-12): лиды НЕ переносим (складским документам не нужны),
 * контакты — ВСЕ. Сделки остаются жить в Б24.
 * Маппинг: компания Б24 → Customer (Company); контакт с компанией → Contact под её
 * Customer; контакт без компании → Customer (Individual) + Contact с телефоном/почтой.
 * Идемпотентный ключ: custom-поле b24_id («company_<id>» / «contact_<id>»).
 * ИДЕМПОТЕНТНО: повторный запуск догоняет дельту, не дублирует.
 *
 * Запуск:  npx tsx scripts/erp-migrate-clients.ts --dry        (посчитать, ничего не писать)
 *          npx tsx scripts/erp-migrate-clients.ts --setup      (custom-поля + нумерация Customer серией)
 *          npx tsx scripts/erp-migrate-clients.ts --companies  (компании → Customer)
 *          npx tsx scripts/erp-migrate-clients.ts --contacts   (контакты → Contact/Customer)
 *          npx tsx scripts/erp-migrate-clients.ts --check      (сверка Б24 vs ERPNext)
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Прокси-грабли ноутбука: Битрикс — через curl -x, локальный ERPNext — undici напрямую
// (подробности в erp-migrate-catalog.ts и docs/sklad-vynos.md).
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const localAgent = new Agent();
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WEBHOOK) { console.error('DEV_WEBHOOK нет'); process.exit(1); }

async function b24call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 5; a++) {
		try {
			const { stdout } = await execFileP('curl.exe', [
				'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
				'-H', 'Content-Type: application/json',
				'-d', JSON.stringify(params),
				`${WEBHOOK}/${method}.json`,
			], { maxBuffer: 64 * 1024 * 1024 });
			const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
			return json.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

async function b24Page<T>(method: string, params: Record<string, unknown>, pick: (r: unknown) => T[]): Promise<T[]> {
	const out: T[] = [];
	let start: number | undefined = 0;
	while (start !== undefined) {
		const raw = await b24call<unknown>(method, { ...params, start });
		const page = pick(raw);
		out.push(...page);
		start = page.length === 50 ? (start as number) + 50 : undefined;
	}
	return out;
}

const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token REDACTED';
const CUSTOMER_GROUP = 'Клиенты Б24';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry') || args.size === 0;

// ── ERPNext REST ──────────────────────────────────────────────────────────────
async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	// Сетевые сбои/зависания ретраим (прогон 2026-06-12 умер на полпути) — HTTP-ответ
	// с ошибкой НЕ ретраим, POST повтор после реального 2xx наплодил бы дублей.
	let last: unknown;
	for (let a = 1; a <= 3; a++) {
		try {
			const res = await undiciRequest(`${ERP}${path}`, {
				method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
				headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				dispatcher: localAgent,
				headersTimeout: 60_000,
				bodyTimeout: 60_000,
			});
			const text = await res.body.text();
			let json: any = null;
			try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
			return { status: res.statusCode, json };
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 1500)); }
	}
	throw last;
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
async function erpCreate(doctype: string, fields: Record<string, unknown>): Promise<string> {
	const r = await erp('POST', `/api/resource/${encodeURIComponent(doctype)}`, fields);
	if (r.status >= 300) throw new Error(`${doctype} create: ${erpErr(r)}`);
	return String(r.json?.data?.name ?? '');
}

// ── Б24 чтение ────────────────────────────────────────────────────────────────
interface Multi { VALUE?: string }
interface B24Company { id: number; title: string }
interface B24Contact { id: number; first: string; last: string; companyId: number; phones: string[]; emails: string[] }

const multiVals = (v: unknown): string[] =>
	Array.isArray(v) ? (v as Multi[]).map((m) => String(m?.VALUE ?? '').trim()).filter(Boolean) : [];

async function readB24Companies(): Promise<B24Company[]> {
	const rows = await b24Page<Record<string, unknown>>('crm.company.list',
		{ select: ['ID', 'TITLE'], order: { ID: 'ASC' } },
		(r) => ((r as Record<string, unknown>[]) ?? []) as Record<string, unknown>[]);
	return rows.map((c) => ({ id: Number(c['ID']), title: String(c['TITLE'] ?? '').trim() }));
}

async function readB24Contacts(): Promise<B24Contact[]> {
	const rows = await b24Page<Record<string, unknown>>('crm.contact.list',
		{ select: ['ID', 'NAME', 'LAST_NAME', 'COMPANY_ID', 'PHONE', 'EMAIL'], order: { ID: 'ASC' } },
		(r) => ((r as Record<string, unknown>[]) ?? []) as Record<string, unknown>[]);
	// frappe запрещает <> в именах (409 на contact_3134 «Александр < Игорь»)
	const clean = (s: unknown): string => String(s ?? '').replace(/[<>]/g, '').trim();
	return rows.map((c) => ({
		id: Number(c['ID']),
		first: clean(c['NAME']),
		last: clean(c['LAST_NAME']),
		companyId: Number(c['COMPANY_ID'] ?? 0),
		phones: multiVals(c['PHONE']),
		emails: multiVals(c['EMAIL']),
	}));
}

// Кривые почты валятся на frappe.validate_email_address — фильтруем простым ситом,
// при ошибке создания ретраим вовсе без contact-данных (см. retry в --contacts).
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const contactChildren = (c: B24Contact) => ({
	...(c.emails.filter((e) => EMAIL_RX.test(e)).length
		? { email_ids: c.emails.filter((e) => EMAIL_RX.test(e)).map((e, i) => ({ email_id: e, is_primary: i === 0 ? 1 : 0 })) }
		: {}),
	...(c.phones.length
		? { phone_nos: c.phones.map((p, i) => ({ phone: p, is_primary_mobile_no: i === 0 ? 1 : 0 })) }
		: {}),
});

const displayName = (c: B24Contact): string => [c.first, c.last].filter(Boolean).join(' ') || `Контакт #${c.id}`;

// ── Фазы ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log(`ERPNext: ${ERP} | режим: ${DRY ? 'DRY (только посчитать)' : [...args].join(' ')}`);
	const ping = await erp('GET', '/api/method/ping');
	if (ping.status !== 200) { console.error('ERPNext недоступен:', erpErr(ping)); process.exit(1); }

	console.log('\nЧитаю Б24: компании, контакты…');
	const [companies, contacts] = await Promise.all([readB24Companies(), readB24Contacts()]);
	const withCompany = contacts.filter((c) => c.companyId > 0);
	console.log(`  компании: ${companies.length}`);
	console.log(`  контакты: ${contacts.length} (с компанией: ${withCompany.length}, физлиц: ${contacts.length - withCompany.length})`);

	if (DRY) { console.log('\nDRY: ничего не пишу. Запусти с --setup / --companies / --contacts / --check'); return; }

	// что уже перенесено (по b24_id) — после --setup поле существует
	const loadMaps = async () => {
		const custRows = await erpList('Customer', ['name', 'b24_id'], [['b24_id', 'like', '%_%']]).catch(() => []);
		const contRows = await erpList('Contact', ['name', 'b24_id'], [['b24_id', 'like', '%_%']]).catch(() => []);
		return {
			customerByB24: new Map(custRows.map((r) => [String(r['b24_id']), String(r['name'])])),
			contactByB24: new Map(contRows.map((r) => [String(r['b24_id']), String(r['name'])])),
		};
	};

	// ── setup: custom-поля + нумерация ──
	if (args.has('--setup')) {
		console.log('\n— SETUP —');
		for (const dt of ['Customer', 'Contact']) {
			const exists = await erpList('Custom Field', ['name'], [['dt', '=', dt], ['fieldname', '=', 'b24_id']]);
			if (exists.length) { console.log(`  = ${dt}.b24_id (есть)`); continue; }
			await erpCreate('Custom Field', {
				dt, fieldname: 'b24_id', label: 'B24 ID', fieldtype: 'Data',
				unique: 1, search_index: 1, no_copy: 1, insert_after: dt === 'Customer' ? 'customer_name' : 'last_name',
			});
			console.log(`  + ${dt}.b24_id`);
		}
		// Тёзки («Иван Иванов» ×3) при нумерации по имени падают дублем → серия CUST-.
		const r = await erp('PUT', '/api/resource/Selling Settings/Selling Settings', { cust_master_name: 'Naming Series' });
		if (r.status >= 300) throw new Error(`Selling Settings: ${erpErr(r)}`);
		console.log('  ✓ Customer нумеруется серией (cust_master_name = Naming Series)');
		if (!(await erpList('Customer Group', ['name'], [['name', '=', CUSTOMER_GROUP]])).length) {
			await erpCreate('Customer Group', { customer_group_name: CUSTOMER_GROUP, parent_customer_group: 'All Customer Groups', is_group: 0 });
			console.log(`  + Customer Group «${CUSTOMER_GROUP}»`);
		}
	}

	// ── компании → Customer ──
	if (args.has('--companies')) {
		console.log('\n— КОМПАНИИ —');
		const { customerByB24 } = await loadMaps();
		let created = 0, skipped = 0, failed = 0;
		for (const co of companies) {
			const key = `company_${co.id}`;
			if (customerByB24.has(key)) { skipped++; continue; }
			try {
				await erpCreate('Customer', {
					customer_name: co.title || `Компания #${co.id}`,
					customer_type: 'Company',
					customer_group: CUSTOMER_GROUP,
					territory: 'All Territories',
					b24_id: key,
				});
				created++;
			} catch (e) {
				failed++;
				if (failed <= 10) console.log(`  ⛔ ${key} «${co.title.slice(0, 40)}»: ${String(e).slice(0, 160)}`);
			}
		}
		console.log(`  ИТОГ компаний: +${created}, уже было ${skipped}, ошибок ${failed}`);
	}

	// ── контакты → Contact (+Customer для физлиц) ──
	if (args.has('--contacts')) {
		console.log('\n— КОНТАКТЫ —');
		const { customerByB24, contactByB24 } = await loadMaps();
		let created = 0, custCreated = 0, skipped = 0, failed = 0, orphanCompany = 0;
		for (const c of contacts) {
			const key = `contact_${c.id}`;
			try {
				// физлицо без компании → свой Customer (для будущих Delivery Note)
				let customerName: string | undefined;
				if (c.companyId > 0) {
					customerName = customerByB24.get(`company_${c.companyId}`);
					if (!customerName) orphanCompany++; // компания удалена/не перенесена — Contact будет без линка
				} else if (!customerByB24.has(key)) {
					customerName = await erpCreate('Customer', {
						customer_name: displayName(c),
						customer_type: 'Individual',
						customer_group: CUSTOMER_GROUP,
						territory: 'All Territories',
						b24_id: key,
					});
					customerByB24.set(key, customerName);
					custCreated++;
				} else {
					customerName = customerByB24.get(key);
				}

				if (contactByB24.has(key)) { skipped++; continue; }
				const base = {
					first_name: c.first || displayName(c),
					...(c.last ? { last_name: c.last } : {}),
					...(customerName ? { links: [{ link_doctype: 'Customer', link_name: customerName }] } : {}),
					b24_id: key,
				};
				try {
					await erpCreate('Contact', { ...base, ...contactChildren(c) });
				} catch {
					await erpCreate('Contact', base); // кривые телефон/почта — создаём голым
				}
				created++;
				if ((created + skipped) % 500 === 0) console.log(`  …обработано ${created + skipped}/${contacts.length}`);
			} catch (e) {
				failed++;
				if (failed <= 10) console.log(`  ⛔ ${key} «${displayName(c).slice(0, 40)}»: ${String(e).slice(0, 160)}`);
			}
		}
		console.log(`  ИТОГ контактов: +${created} Contact, +${custCreated} Customer-физлиц, уже было ${skipped}, ошибок ${failed}, контактов с потерянной компанией ${orphanCompany}`);
	}

	// ── сверка ──
	if (args.has('--check')) {
		console.log('\n— СВЕРКА —');
		const { customerByB24, contactByB24 } = await loadMaps();
		const missCompanies = companies.filter((co) => !customerByB24.has(`company_${co.id}`));
		const missContacts = contacts.filter((c) => !contactByB24.has(`contact_${c.id}`));
		const missIndividuals = contacts.filter((c) => c.companyId === 0 && !customerByB24.has(`contact_${c.id}`));
		console.log(`  Customer-компаний: ${[...customerByB24.keys()].filter((k) => k.startsWith('company_')).length}/${companies.length}; нет: ${missCompanies.length}${missCompanies.length ? ' → ' + missCompanies.slice(0, 20).map((c) => c.id).join(',') : ''}`);
		console.log(`  Contact: ${contactByB24.size}/${contacts.length}; нет: ${missContacts.length}${missContacts.length ? ' → ' + missContacts.slice(0, 20).map((c) => c.id).join(',') : ''}`);
		console.log(`  Customer-физлиц: ${[...customerByB24.keys()].filter((k) => k.startsWith('contact_')).length}; без Customer: ${missIndividuals.length}`);
		console.log(missCompanies.length + missContacts.length + missIndividuals.length === 0 ? '  ✅ СВЕРКА В НОЛЬ' : '  ⚠ есть расхождения (см. выше)');
	}
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
