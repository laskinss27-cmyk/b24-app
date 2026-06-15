/**
 * МИГРАЦИЯ каталога и остатков Б24 → ERPNext (домашний этап выноса склада).
 * Решения (Сергей 2026-06-11): вариации = ОТДЕЛЬНЫЕ товары (плоско), Item Code = productId Б24,
 * склады — зеркало Б24 по именам, UOM «шт».
 * ИДЕМПОТЕНТНО: повторный запуск догоняет дельту, не дублирует.
 *
 * Запуск:  npx tsx scripts/erp-migrate-catalog.ts --dry           (посчитать, ничего не писать)
 *          npx tsx scripts/erp-migrate-catalog.ts --stores --items (склады + товары)
 *          npx tsx scripts/erp-migrate-catalog.ts --stock          (начальные остатки)
 *          npx tsx scripts/erp-migrate-catalog.ts --check          (сверка Б24 vs ERPNext)
 */
import 'dotenv/config';
import { request as undiciRequest, Agent } from 'undici';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Ноутбук Сергея ходит в интернет через локальный прокси (системный socks 10808 / http 10809):
// напрямую Битрикс не отвечает, а через undici ProxyAgent — необъяснимые connect-таймауты
// (час проб, см. test-proxy.ts). Поэтому Битрикс читаем ЧЕРЕЗ CURL с -x прокси (работает
// стабильно, проверено), а локальный ERPNext — undici.request с прямым Agent.
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const localAgent = new Agent();
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');
if (!WEBHOOK) { console.error('DEV_WEBHOOK нет'); process.exit(1); }

/** Вызов Б24 через curl (системный прокси), с ретраями. */
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

const ERP = process.env['ERPNEXT_URL'] ?? 'http://localhost:8080';
const ERP_AUTH = process.env['ERPNEXT_TOKEN'] ?? 'token 75a1085fa14560a:df3408f48a7428f';
const ITEM_GROUP = 'Каталог Б24';
const UOM = 'шт';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry') || args.size === 0;

// ── ERPNext REST ──────────────────────────────────────────────────────────────
async function erp(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
	const res = await undiciRequest(`${ERP}${path}`, {
		method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
		headers: { Authorization: ERP_AUTH, 'Content-Type': 'application/json' },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		dispatcher: localAgent, // мимо глобального прокси — ERPNext локальный
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
async function erpExists(doctype: string, name: string): Promise<boolean> {
	const r = await erp('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}?fields=["name"]`);
	return r.status === 200;
}
async function erpCreate(doctype: string, fields: Record<string, unknown>): Promise<string> {
	const r = await erp('POST', `/api/resource/${encodeURIComponent(doctype)}`, fields);
	if (r.status >= 300) throw new Error(`${doctype} create: ${erpErr(r)}`);
	return String(r.json?.data?.name ?? '');
}
async function erpSubmit(doctype: string, name: string): Promise<void> {
	// PUT docstatus=1 — штатное проведение через REST. ПРОВЕРЯЕМ результат: frappe.client.submit
	// с частичным doc возвращал 200 НЕ проведя документ (грабли 2026-06-11).
	const r = await erp('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, { docstatus: 1 });
	if (r.status >= 300) throw new Error(`${doctype} submit: ${erpErr(r)}`);
	const after = Number(r.json?.data?.docstatus ?? 0);
	if (after !== 1) throw new Error(`${doctype} ${name}: submit прошёл без ошибки, но docstatus=${after}`);
}

// ── Б24 чтение (постранично) ──────────────────────────────────────────────────
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

interface B24Product { id: number; name: string; type: number; purchasing: number | null; iblockId: number; supplier?: string }

/** Значение свойства Б24: приходит как {value: …} или плоско. */
const propVal = (v: unknown): string => {
	const raw = v && typeof v === 'object' ? (v as { value?: unknown }).value : v;
	return raw == null ? '' : String(raw).trim();
};

/** ЦВЕТ вариации (property358): HL-справочник, REST его не отдаёт — словарь добыт из
 *  рендера страниц вариаций браузером Сергея (2026-06-11). Хэш = xmlId элемента HL. */
const COLOR_BY_HASH: Record<string, string> = {
	'1eff65b3f347398a0d5902bab36db070': 'Бежевый',
	'acf5a9db51ebfa52ee2fa27bceede570': 'Алюминевый',
	'7bd07acd8ae362d197671e2fa68d1fa6': 'Антрацит',
	'e8537837e50eb70f276924da9186014c': 'Белый',
	'c22f761aa8d751e7fec6b109ce3983e8': 'Молочный',
	'1e86d55001bec44be3ef73dfef337279': 'Титан',
	'cA1i1w2t': 'Металлик',
	'4e450c83a63e2d29745c258b0e68e025': 'Графит',
	'q5n36u4D': 'Черный',
	'ScLYqY10': 'Фиолетовый',
	'OStRGTHN': 'Серебро',
	'kgB6lI71': 'Красный',
	'z4QHCqVa': 'Голубой',
	'3999cdc59b1ec591294b7cb2b8e42c7d': 'Серый',
	'458b94d5413a44c54b4cfedf196471d4': 'Медь',
	'9a13a88e6c981a9be004f93aa6a68510': 'Гавана',
	'31e253e5a7e4972828b5dacf3a78d996': 'Бронза',
	'c3be063e7b92af1f4a58cc0505b890aa': 'Бронза Атик',
	'93bdd632899f1bceefb03da3ae5195bf': 'Серебро Атик',
	'2eb11622335f204174117a83cb574882': 'Золото',
};

async function readB24Catalog(): Promise<B24Product[]> {
	// Справочник значений вариация-свойства (property360, enum): id → текст («белая», «12В»…).
	const enumMap = new Map<number, string>();
	try {
		const enums = await b24Page('catalog.productPropertyEnum.list',
			{ filter: { propertyId: 360 }, order: { id: 'ASC' } },
			(r) => ((r as { productPropertyEnums?: Array<Record<string, unknown>> })?.productPropertyEnums ?? []));
		for (const e of enums) enumMap.set(Number(e['id']), String(e['value'] ?? '').trim());
		console.log(`  справочник вариаций (property360): ${enumMap.size} значений`);
	} catch { console.log('  ⚠ справочник вариаций не прочитался — лейблы будут числами'); }

	const products: B24Product[] = [];
	for (const iblockId of [24, 26]) {
		// У вариаций (26): property358 — ЦВЕТ (HL-хэш → COLOR_BY_HASH), property360 — артикул
		// вариации (enum), property350 — поставщик («вариации по поставщику» с одинаковым 360!).
		// Приоритет отличительного признака в имени: цвет → артикул → (для тёзок) поставщик/#id.
		const select = iblockId === 26
			? ['id', 'iblockId', 'name', 'type', 'purchasingPrice', 'property358', 'property360', 'property350']
			: ['id', 'iblockId', 'name', 'type', 'purchasingPrice'];
		const rows = await b24Page('catalog.product.list',
			{ filter: { iblockId }, select, order: { id: 'ASC' } },
			(r) => ((r as { products?: Array<Record<string, unknown>> })?.products ?? []));
		for (const p of rows) {
			let name = String(p['name'] ?? '').trim();
			let supplier = '';
			if (iblockId === 26) {
				const colorHash = propVal(p['property358']);
				const color = colorHash && colorHash !== '0' ? COLOR_BY_HASH[colorHash] : undefined;
				const raw = propVal(p['property360']);
				const art = /^\d+$/.test(raw) ? (enumMap.get(Number(raw)) ?? raw) : raw;
				const label = color ?? art;
				if (label && !name.toLowerCase().includes(label.toLowerCase())) name = `${name} [${label}]`;
				supplier = propVal(p['property350']).split(';')[0]?.trim() ?? '';
			}
			products.push({
				id: Number(p['id']),
				name,
				type: Number(p['type'] ?? 0),
				purchasing: p['purchasingPrice'] != null ? Number(p['purchasingPrice']) : null,
				iblockId,
				supplier,
			});
		}
	}

	// Тёзки после обогащения (вариации «по поставщику» с одинаковым 360) — довешиваем
	// поставщиком, а неразличимых и так — номером карточки. Цель: ноль слепых дублей-вариаций.
	const byName = new Map<string, B24Product[]>();
	for (const p of products) {
		if (p.iblockId !== 26) continue;
		const g = byName.get(p.name) ?? [];
		g.push(p);
		byName.set(p.name, g);
	}
	for (const group of byName.values()) {
		if (group.length < 2) continue;
		for (const p of group) {
			const supplierTag = p.supplier ? ` [${p.supplier.replace(/ООО\s*|"|«|»|&quot;/g, '').trim()}]` : '';
			p.name = `${p.name}${supplierTag}`;
		}
		// если и с поставщиком совпали (один поставщик, разные закупки) — добиваем номером
		const seen = new Map<string, number>();
		for (const p of group) {
			const n = (seen.get(p.name) ?? 0) + 1;
			seen.set(p.name, n);
			if (n > 1) p.name = `${p.name} [#${p.id}]`;
		}
	}
	return products;
}

async function readB24Stores(): Promise<Array<{ id: number; title: string; active: boolean }>> {
	const r = await b24call<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', { select: ['id', 'title', 'active'], order: { id: 'ASC' } });
	return (r?.stores ?? []).map((s) => ({ id: Number(s['id']), title: String(s['title'] ?? ''), active: s['active'] === 'Y' }));
}

async function readB24Stock(): Promise<Array<{ productId: number; storeId: number; amount: number }>> {
	const rows = await b24Page('catalog.storeproduct.list',
		{ select: ['productId', 'storeId', 'amount'], order: { id: 'ASC' } },
		(r) => ((r as { storeProducts?: Array<Record<string, unknown>> })?.storeProducts ?? []));
	return rows.map((r) => ({ productId: Number(r['productId']), storeId: Number(r['storeId']), amount: Number(r['amount'] ?? 0) }));
}

// ── Фазы ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
	console.log(`ERPNext: ${ERP} | режим: ${DRY ? 'DRY (только посчитать)' : [...args].join(' ')}`);
	const ping = await erp('GET', '/api/method/ping');
	if (ping.status !== 200) { console.error('ERPNext недоступен:', erpErr(ping)); process.exit(1); }

	const company = (await erpList('Company', ['name', 'abbr']))[0];
	if (!company) { console.error('В ERPNext нет компании — пройди setup wizard'); process.exit(1); }
	const abbr = String(company['abbr']);
	console.log(`Компания: ${company['name']} (${abbr})`);

	console.log('\nЧитаю Б24: каталог, склады, остатки…');
	const [catalog, stores, stock] = await Promise.all([readB24Catalog(), readB24Stores(), readB24Stock()]);
	const byType = new Map<number, number>();
	for (const p of catalog) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
	console.log(`  каталог: ${catalog.length} позиций; типы: ${[...byType.entries()].map(([t, n]) => `type${t}=${n}`).join(', ')}`);
	console.log(`  склады: ${stores.length} (${stores.filter((s) => s.active).length} активных)`);
	// Порог 1e-6 (а не >0): апстрим иногда отдаёт машинный эпсилон (2.22e-16 = 2⁻⁵²) вместо чистого нуля.
	// Без допуска эта «пыль» проходит в проводку (qty≈0), а ERPNext её отвергает «нет движения» (HTTP 417,
	// валило синк 2026-06-12..15). Тот же допуск, что и в --check ниже — иначе пыль невидима для сверки.
	const EPS = 1e-6;
	const stockPos = stock.filter((s) => s.amount > EPS);
	console.log(`  остатки: ${stock.length} записей, из них >0: ${stockPos.length}; суммарно ${stockPos.reduce((a, s) => a + s.amount, 0)} ед.`);

	// Товары для переноса: всё, кроме SKU-родителей (type 3 — контейнеры вариаций без остатков).
	const items = catalog.filter((p) => p.type !== 3 && p.name);
	const skipped = catalog.length - items.length;
	console.log(`  к переносу: ${items.length} (пропускаем SKU-родителей/пустые: ${skipped})`);

	if (DRY) { console.log('\nDRY: ничего не пишу. Запусти с --stores --items / --stock / --check'); return; }

	// ── склады ──
	if (args.has('--stores')) {
		console.log('\n— СКЛАДЫ —');
		for (const s of stores) {
			const erpName = `${s.title} - ${abbr}`;
			if (await erpExists('Warehouse', erpName)) { console.log(`  = ${s.title} (есть)`); continue; }
			await erpCreate('Warehouse', { warehouse_name: s.title, company: company['name'] });
			console.log(`  + ${s.title}`);
		}
	}

	// ── товары ──
	if (args.has('--items')) {
		console.log('\n— ТОВАРЫ —');
		if (!(await erpExists('UOM', UOM))) { await erpCreate('UOM', { uom_name: UOM }); console.log(`  + UOM «${UOM}»`); }
		if (!(await erpExists('Item Group', ITEM_GROUP))) {
			await erpCreate('Item Group', { item_group_name: ITEM_GROUP, parent_item_group: 'All Item Groups', is_group: 0 });
			console.log(`  + Item Group «${ITEM_GROUP}»`);
		}
		const existing = new Map(
			(await erpList('Item', ['name', 'item_name'], [['item_group', '=', ITEM_GROUP]]))
				.map((i) => [String(i['name']), String(i['item_name'] ?? '')]),
		);
		console.log(`  в ERPNext уже: ${existing.size}`);
		let created = 0, renamed = 0, failed = 0;
		for (const p of items) {
			const code = String(p.id);
			const wantName = p.name.slice(0, 140);
			if (existing.has(code)) {
				// Идемпотентное переименование: имя в Б24 (с обогащением вариаций) — истина.
				if (existing.get(code) !== wantName) {
					try {
						const r = await erp('PUT', `/api/resource/Item/${encodeURIComponent(code)}`, { item_name: wantName });
						if (r.status >= 300) throw new Error(erpErr(r));
						renamed++;
						if (renamed % 50 === 0) console.log(`  …переименовано ${renamed}`);
					} catch (e) {
						failed++;
						if (failed <= 10) console.log(`  ⛔ rename ${code}: ${String(e).slice(0, 140)}`);
					}
				}
				continue;
			}
			try {
				await erpCreate('Item', {
					item_code: code,
					item_name: wantName,
					item_group: ITEM_GROUP,
					stock_uom: UOM,
					// type 7 = услуги Б24 — позиции без складского учёта; товары (1) и вариации (4) — складские.
					is_stock_item: p.type === 7 ? 0 : 1,
					description: `Б24 productId=${p.id} (iblock ${p.iblockId}, type ${p.type})`,
					...(p.purchasing != null && p.purchasing > 0 ? { valuation_rate: p.purchasing } : {}),
				});
				created++;
				if (created % 200 === 0) console.log(`  …создано ${created}`);
			} catch (e) {
				failed++;
				if (failed <= 10) console.log(`  ⛔ ${code} «${p.name.slice(0, 40)}»: ${String(e).slice(0, 160)}`);
			}
		}
		console.log(`  ИТОГ товаров: +${created}, переименовано ${renamed}, ошибок ${failed}, было ${existing.size}`);
	}

	// ── остатки (Opening Stock через Stock Reconciliation) ──
	if (args.has('--stock')) {
		console.log('\n— ОСТАТКИ —');
		const storeName = new Map(stores.map((s) => [s.id, `${s.title} - ${abbr}`]));
		const purch = new Map(items.map((p) => [p.id, p.purchasing ?? 0]));
		const itemSet = new Set(items.map((p) => String(p.id)));
		// что уже лежит в ERPNext (Bin) — для идемпотентности грузим один раз
		const bins = await erpList('Bin', ['item_code', 'warehouse', 'actual_qty']);
		const haveQty = new Map(bins.map((b) => [`${b['item_code']}|${b['warehouse']}`, Number(b['actual_qty'] ?? 0)]));
		const rows = stockPos
			.filter((s) => itemSet.has(String(s.productId)) && storeName.has(s.storeId))
			.map((s) => ({
				item_code: String(s.productId),
				warehouse: storeName.get(s.storeId)!,
				qty: s.amount,
				valuation_rate: Math.max(purch.get(s.productId) ?? 0, 0.01),
			}))
			.filter((r) => (haveQty.get(`${r.item_code}|${r.warehouse}`) ?? 0) !== r.qty);
		// зануление: в ERPNext остаток есть, а в Б24 нулевой/пропал (движение после миграции)
		const b24Qty = new Map(stock.filter((s) => storeName.has(s.storeId)).map((s) => [`${s.productId}|${storeName.get(s.storeId)}`, s.amount]));
		const whSet = new Set(storeName.values());
		const zeroRows = bins
			.filter((b) => Number(b['actual_qty'] ?? 0) > 0
				&& whSet.has(String(b['warehouse']))
				&& itemSet.has(String(b['item_code']))
				&& (b24Qty.get(`${b['item_code']}|${b['warehouse']}`) ?? 0) === 0)
			.map((b) => ({ item_code: String(b['item_code']), warehouse: String(b['warehouse']), qty: 0, valuation_rate: 0.01 }));
		if (zeroRows.length) console.log(`  зануление лишних в ERP: ${zeroRows.length} строк`);
		rows.push(...zeroRows);
		console.log(`  строк к загрузке: ${rows.length} (совпавшие с ERPNext пропущены)`);
		const noPurch = rows.filter((r) => r.valuation_rate === 0.01).length;
		if (noPurch) console.log(`  ⚠ без закупочной цены (valuation 0.01): ${noPurch} строк`);
		// Opening Stock требует разностный счёт типа активы/пассивы — штатный Temporary Opening.
		const tmpAcc = (await erpList('Account', ['name'], [['account_type', '=', 'Temporary']]))[0];
		if (!tmpAcc) throw new Error('не нашёл счёт Temporary Opening в плане счетов');
		console.log(`  разностный счёт: ${tmpAcc['name']}`);
		for (let i = 0; i < rows.length; i += 200) {
			const chunk = rows.slice(i, i + 200);
			const name = await erpCreate('Stock Reconciliation', {
				// company ЯВНО: в инсталляции две компании, дефолт — «(Demo)», склады не её (грабли 2026-06-11).
				company: String(company['name']),
				purpose: 'Opening Stock',
				set_posting_time: 1,
				posting_date: new Date().toISOString().slice(0, 10),
				expense_account: String(tmpAcc['name']),
				items: chunk,
			});
			await erpSubmit('Stock Reconciliation', name);
			console.log(`  ✅ Stock Reconciliation ${name}: ${chunk.length} строк (${i + chunk.length}/${rows.length})`);
		}
	}

	// ── сверка ──
	if (args.has('--check')) {
		console.log('\n— СВЕРКА Б24 vs ERPNext —');
		const storeName = new Map(stores.map((s) => [s.id, `${s.title} - ${abbr}`]));
		const bins = await erpList('Bin', ['item_code', 'warehouse', 'actual_qty']);
		const erpQty = new Map(bins.map((b) => [`${b['item_code']}|${b['warehouse']}`, Number(b['actual_qty'] ?? 0)]));
		let mismatch = 0, checked = 0;
		const b24Keys = new Set<string>();
		for (const s of stockPos) {
			const wh = storeName.get(s.storeId);
			if (!wh) continue;
			const key = `${s.productId}|${wh}`;
			b24Keys.add(key);
			checked++;
			const e = erpQty.get(key) ?? 0;
			if (Math.abs(e - s.amount) > 1e-6) {
				mismatch++;
				if (mismatch <= 20) console.log(`  ≠ товар ${s.productId} @ ${wh}: Б24=${s.amount}, ERP=${e}`);
			}
		}
		let extra = 0;
		for (const [key, qty] of erpQty) if (qty > 0 && !b24Keys.has(key)) { extra++; if (extra <= 10) console.log(`  + лишнее в ERP: ${key} = ${qty}`); }
		console.log(`  ИТОГ: позиций сверено ${checked}, расхождений ${mismatch}, лишних в ERP ${extra}`);
		console.log(mismatch === 0 && extra === 0 ? '  ✅ СОШЛОСЬ В НОЛЬ' : '  ⚠ есть расхождения — смотри выше');
	}

	console.log('\nГОТОВО');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
