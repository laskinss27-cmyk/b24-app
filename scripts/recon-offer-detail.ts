/**
 * Read-only: чем РЕАЛЬНО различаются два оффера одного родителя?
 * Кейс: "Трубка аудиодомофона УКП-12" — офферы 18732 (property360=128) и 18734 (392),
 * имя одинаковое. Ищем человекочитаемый признак варианта (Цвет/SKU-свойство).
 *
 * Дампим оба оффера + родителя целиком, считаем diff полей. Плюс пробуем методы
 * SKU-свойств, которые catalog.product.get не отдаёт.
 *
 * npx tsx scripts/recon-offer-detail.ts
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

function flat(p: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(p)) {
		const val = v && typeof v === 'object' && 'value' in (v as Record<string, unknown>) ? (v as { value: unknown }).value : v;
		if (val === null || val === undefined || val === '' || (Array.isArray(val) && !val.length)) continue;
		out[k] = typeof val === 'object' ? JSON.stringify(val) : String(val);
	}
	return out;
}

async function main(): Promise<void> {
	const A = 18732, B = 18734, PARENT = 18730;
	const ga = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: A }))?.product ?? {};
	const gb = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: B }))?.product ?? {};
	const gp = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id: PARENT }))?.product ?? {};

	const fa = flat(ga), fb = flat(gb);
	console.log('=== РОДИТЕЛЬ 18730 (непустые поля) ===');
	console.log(JSON.stringify(flat(gp), null, 2));

	console.log('\n=== DIFF офферов 18732 vs 18734 (только различающиеся поля) ===');
	const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort();
	for (const k of keys) {
		if (fa[k] !== fb[k]) console.log(`  ${k}: ${fa[k] ?? '∅'}  |  ${fb[k] ?? '∅'}`);
	}

	console.log('\n=== Полный непустой дамп оффера 18732 (увидеть все доступные поля) ===');
	console.log(JSON.stringify(fa, null, 2));

	// Пробуем достать SKU-свойства оффера (catalog.product.get их не отдаёт по-человечески)
	console.log('\n=== Пробы методов SKU-свойств ===');
	const cfg = await call<unknown>('catalog.productPropertyValue.list', { filter: { productId: A } });
	if (cfg) console.log('productPropertyValue.list:', JSON.stringify(cfg, null, 2).slice(0, 1200));
	const off = await call<unknown>('catalog.product.offer.list', { filter: { iblockId: 26, id: [A, B] }, select: ['id', 'name', 'property360'] });
	if (off) console.log('product.offer.list:', JSON.stringify(off, null, 2).slice(0, 1200));

	console.log('\nГОТОВО — ничего не записано');
}
main().catch((err) => { console.error(err); process.exit(1); });
