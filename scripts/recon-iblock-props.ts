/**
 * Read-only: как НАЗЫВАЮТСЯ свойства офферов (property360/358/330/108/104…)
 * и какое из них — различитель варианта (то, что страница товара показывает
 * как «вариацию»). Каталог: iblock 24 = товары/родители, iblock 26 = офферы.
 *
 * npx tsx scripts/recon-iblock-props.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(method, params); }
	catch (err) { console.log(`  ⛔ ${method} → ${err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err)}`); return null; }
}

async function dumpProps(iblockId: number): Promise<void> {
	console.log(`\n=== Свойства iblock ${iblockId} (catalog.productProperty.list) ===`);
	const all: Array<Record<string, unknown>> = [];
	for (let start = 0; start < 1000; start += 50) {
		const res = await call<{ productProperties?: Array<Record<string, unknown>> }>('catalog.productProperty.list', { filter: { iblockId }, start });
		const page = res?.productProperties ?? [];
		all.push(...page);
		if (page.length < 50) break;
	}
	if (!all.length) { console.log('  (пусто/нет доступа)'); return; }
	for (const p of all) {
		console.log(`  property${p['id']} · "${p['name']}" · тип=${p['propertyType']}${p['userType'] ? '/' + p['userType'] : ''} · код=${p['code'] ?? ''}`);
	}
}

async function main(): Promise<void> {
	// 1. Имена свойств обоих iblock
	await dumpProps(24);
	await dumpProps(26);

	// 2. Какое свойство iblock 26 — «свойство торгового предложения» (SKU-различитель)?
	console.log('\n=== Пробы методов SKU/вариаций ===');
	for (const m of ['catalog.productProperty.list', 'iblock.section.list']) {
		const r = await call<unknown>(m, { iblockId: 26 });
		if (r) console.log(`${m}:`, JSON.stringify(r, null, 2).slice(0, 800));
	}

	// 3. Значение property360 у двух офферов УКП-12 + что это за свойство по списку
	console.log('\n=== Контроль: офферы 18732/18734, поле property360 ===');
	for (const id of [18732, 18734]) {
		const p = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id }))?.product ?? {};
		console.log(`  ${id}: name="${p['name']}" property360=${(p['property360'] as { value?: unknown } | undefined)?.value ?? p['property360']}`);
	}

	console.log('\nГОТОВО — ничего не записано');
}
main().catch((err) => { console.error(err); process.exit(1); });
