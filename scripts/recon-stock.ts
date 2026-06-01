/**
 * Read-only: ищем настоящий метод остатков по складам.
 * catalog.store.product.list вернул ERROR_METHOD_NOT_FOUND — выясняем, что доступно.
 * Зовём ТОЛЬКО `methods` (интроспекция) и кандидатов на `.list` (чтение). Ничего не пишем.
 *
 * npx tsx scripts/recon-stock.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		if (err instanceof B24ApiError) console.log(`  ⛔ ${method} → ${err.code}: ${err.description ?? ''}`);
		else console.log(`  ⛔ ${method} → ${String(err)}`);
		return null;
	}
}

function toNames(res: unknown): string[] {
	if (Array.isArray(res)) return res.map(String);
	if (res && typeof res === 'object') return Object.keys(res as Record<string, unknown>);
	return [];
}

async function main(): Promise<void> {
	const rx = /store|stock|amount|warehouse|остат|inventory/i;

	console.log('=== methods (scope=catalog) ===');
	const cat = await tryCall('methods', { scope: 'catalog', full: true });
	const catNames = toNames(cat);
	console.log(`методов в scope catalog: ${catNames.length}`);
	console.log('кандидаты на остатки:', JSON.stringify(catNames.filter((n) => rx.test(n)), null, 2));

	console.log('\n=== methods (без скоупа — все доступные) ===');
	const allRes = await tryCall('methods', {});
	const allNames = toNames(allRes);
	const allHits = allNames.filter((n) => rx.test(n));
	console.log(`всего методов: ${allNames.length}`);
	console.log('кандидаты (все скоупы):', JSON.stringify(allHits, null, 2));

	// также покажем все catalog.* — чтобы глазами увидеть форму API остатков/складов
	console.log('\ncatalog.* методы:', JSON.stringify(allNames.filter((n) => /^catalog\./.test(n)).sort(), null, 2));

	// 2. Пробуем кандидатов на чтение остатков (только .list — это чтение)
	const PROBE_PID = 18062; // Гофротруба из прошлой разведки
	const candidates = [...new Set([
		...catNames.filter((n) => rx.test(n)),
		...allHits,
		'catalog.storeproduct.list',
		'catalog.product.store.list',
	])].filter((n) => /\.list$/.test(n));

	console.log(`\n=== пробую кандидатов (.list, read-only): ${JSON.stringify(candidates)} ===`);
	for (const m of candidates) {
		const res = await tryCall<Record<string, unknown>>(m, { filter: { productId: PROBE_PID } });
		if (res) {
			console.log(`\n  ✅ ${m} → ОТВЕТ ЕСТЬ. Форма:`);
			console.log(JSON.stringify(res, null, 2).slice(0, 1800));
		}
	}

	console.log('\nГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
