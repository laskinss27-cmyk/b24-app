/**
 * Read-only: разложить ДВА ТИПА товаров для «Базы товаров».
 * Простые (iblock 24, type 1) vs офферы «с предложениями» (iblock 26, type 4).
 * Для каждого типа смотрим, чем заполнять колонки: имя, БРЕНД (производитель),
 * модель/вариация, фото. Для офферов бренд, вероятно, лежит у РОДИТЕЛЯ (iblock 24).
 *
 * npx tsx scripts/recon-two-types.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const STORE = 8;

async function call<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? e.code : String(e)}`); return null; }
}
const val = (p: Record<string, unknown> | undefined, k: string): string => {
	if (!p) return '';
	const v = p[k];
	const raw = v && typeof v === 'object' && 'value' in (v as Record<string, unknown>) ? (v as { value: unknown }).value : v;
	return raw == null ? '' : String(raw);
};

async function main(): Promise<void> {
	// остатки склада
	const rows: Array<Record<string, unknown>> = [];
	for (let start = 0; ; start += 50) {
		const r = await call<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { filter: { storeId: STORE }, select: ['productId', 'amount'], start });
		const page = r?.storeProducts ?? [];
		rows.push(...page);
		if (page.length < 50) break;
	}
	const ids = [...new Set(rows.filter((r) => Number(r['amount']) > 0).map((r) => Number(r['productId'])))];

	// типы по всем + соберём по 6 примеров каждого типа
	const simples: number[] = [], offers: number[] = [];
	for (let i = 0; i < ids.length && (simples.length < 6 || offers.length < 6); i += 50) {
		const chunk = ids.slice(i, i + 50);
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of chunk) calls[`p${id}`] = { method: 'catalog.product.get', params: { id } };
		const b = await client.callBatch(calls);
		for (const id of chunk) {
			const p = (b.result[`p${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
			if (!p) continue;
			const t = Number(p['type']);
			if (t === 1 && simples.length < 6) simples.push(id);
			else if (t === 4 && offers.length < 6) offers.push(id);
		}
	}

	console.log('\n========== ПРОСТЫЕ (type 1, iblock 24) ==========');
	for (const id of simples) {
		const p = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id }))?.product ?? {};
		console.log(JSON.stringify({
			id, name: val(p, 'name'),
			'произв(334)': val(p, 'property334'),
			'модель(330)': val(p, 'property330'),
			'поставщик(336)': val(p, 'property336'),
			detailPic: !!p['detailPicture'], previewPic: !!p['previewPicture'], 'галерея(100)': val(p, 'property100') ? 'есть' : '',
		}));
	}

	console.log('\n========== ОФФЕРЫ (type 4, iblock 26) + РОДИТЕЛЬ ==========');
	for (const id of offers) {
		const p = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id }))?.product ?? {};
		const parentId = Number(val(p, 'parentId') || val(p, 'property102'));
		const par = parentId ? (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: parentId }))?.product : undefined;
		console.log(JSON.stringify({
			id, name: val(p, 'name'),
			'модель оффера(360)': val(p, 'property360'),
			'цвет(358)': val(p, 'property358') ? 'есть(hash)' : '',
			'поставщик оффера(350)': val(p, 'property350'),
			'галерея оффера(104)': val(p, 'property104') ? 'есть' : '',
			parentId,
			'РОДИТЕЛЬ произв(334)': val(par, 'property334'),
			'РОДИТЕЛЬ модель(330)': val(par, 'property330'),
		}));
	}

	console.log('\nГОТОВО — ничего не записано');
}
main().catch((e) => { console.error(e); process.exit(1); });
