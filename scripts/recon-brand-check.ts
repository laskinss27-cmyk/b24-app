/**
 * Read-only: проверяем, что фикс enrichProducts реально даст бренд.
 * Для офферов склада 8 догружаем родителей и смотрим заполненность property334 (Производитель)
 * + property330 (Модель). Для простых — их собственный property334.
 *
 * npx tsx scripts/recon-brand-check.ts
 */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';

const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
const STORE = 8;
const pv = (v: unknown): string => {
	if (v && typeof v === 'object') return String((v as { value?: unknown }).value ?? '');
	return v == null ? '' : String(v);
};

async function getMany(ids: number[], pfx: string): Promise<Map<number, Record<string, unknown>>> {
	const out = new Map<number, Record<string, unknown>>();
	for (let i = 0; i < ids.length; i += 40) {
		const chunk = ids.slice(i, i + 40);
		const calls: Record<string, { method: string; params: Record<string, unknown> }> = {};
		for (const id of chunk) calls[`${pfx}${id}`] = { method: 'catalog.product.get', params: { id } };
		const r = await client.callBatch(calls);
		for (const id of chunk) {
			const p = (r.result[`${pfx}${id}`] as { product?: Record<string, unknown> } | undefined)?.product;
			if (p) out.set(id, p);
		}
	}
	return out;
}

async function main(): Promise<void> {
	const ids: number[] = [];
	for (let start = 0; ; start += 50) {
		const r = await client.call<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', { filter: { storeId: STORE }, select: ['productId', 'amount'], start });
		const page = r?.storeProducts ?? [];
		for (const sp of page) if (Number(sp['amount'] ?? 0) > 0) ids.push(Number(sp['productId']));
		if (page.length < 50) break;
	}
	const uniq = [...new Set(ids.filter((x) => x > 0))];
	console.log(`товаров склада ${STORE} (amount>0): ${uniq.length}`);

	const prod = await getMany(uniq, 'p');
	const offers: number[] = [], simples: number[] = [];
	for (const [id, p] of prod) (pv(p['parentId']) && Number(pv(p['parentId'])) > 0 ? offers : simples).push(id);
	console.log(`офферов (есть parentId): ${offers.length} | простых: ${simples.length}`);

	const parentIds = [...new Set(offers.map((id) => Number(pv(prod.get(id)!['parentId']))).filter((x) => x > 0))];
	const parents = await getMany(parentIds, 'par');

	// заполненность бренда
	const simpBrand = simples.filter((id) => pv(prod.get(id)!['property334'])).length;
	const offBrand = offers.filter((id) => { const par = parents.get(Number(pv(prod.get(id)!['parentId']))); return par && pv(par['property334']); }).length;
	console.log(`\nБРЕНД (property334) заполнен:`);
	console.log(`  простые: ${simpBrand}/${simples.length}`);
	console.log(`  офферы (через родителя): ${offBrand}/${offers.length}`);

	console.log(`\nПримеры офферов (оффер → бренд[родитель] · модель):`);
	for (const id of offers.slice(0, 10)) {
		const p = prod.get(id)!; const par = parents.get(Number(pv(p['parentId'])));
		console.log(`  ${id} "${pv(p['name'])}" → бренд="${par ? pv(par['property334']) : '?'}" · модель(360)="${pv(p['property360'])}"/родит330="${par ? pv(par['property330']) : ''}"`);
	}
	console.log(`\nПримеры простых (товар → бренд · модель):`);
	for (const id of simples.slice(0, 6)) {
		const p = prod.get(id)!;
		console.log(`  ${id} "${pv(p['name'])}" → бренд="${pv(p['property334'])}" · модель(330)="${pv(p['property330'])}"`);
	}
	console.log('\nГОТОВО — ничего не записано');
}
main().catch((e) => { console.error(e); process.exit(1); });
