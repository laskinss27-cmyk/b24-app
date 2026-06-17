/**
 * Read-only: разворачиваются ли значения свойств-вариантов в человеческие подписи?
 *   - property360 "Модель" (тип L=список) → id 128/392 → текст?
 *   - property358 "Цвет" (тип S/directory) → XML_ID хеш → название цвета?
 *   - property110 "Цвет камеры" (directory)
 * Без разворота фикс вариантов не имеет смысла.
 *
 * npx tsx scripts/recon-resolve-variant.ts
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

async function main(): Promise<void> {
	// 1. Полные определения свойств 358 (Цвет) и 360 (Модель) — там userTypeSettings (HL-блок/привязка)
	console.log('=== Определения свойств 358 "Цвет" и 360 "Модель" ===');
	const defs = await call<{ productProperties?: Array<Record<string, unknown>> }>('catalog.productProperty.list', { filter: { iblockId: 26 } });
	for (const p of defs?.productProperties ?? []) {
		if ([358, 360, 110].includes(Number(p['id']))) {
			console.log(`property${p['id']} "${p['name']}" type=${p['propertyType']}/${p['userType'] ?? ''}`);
			console.log('  userTypeSettings:', JSON.stringify(p['userTypeSettings']));
			console.log('  values(если есть):', JSON.stringify(p['values'] ?? p['enum'] ?? null));
		}
	}

	// 2. Список значений для list-свойства 360 "Модель"
	console.log('\n=== enum значений property360 "Модель" ===');
	for (const m of ['catalog.productPropertyEnum.list', 'catalog.productPropertyEnum.get']) {
		const r = await call<unknown>(m, { filter: { propertyId: 360 } });
		if (r) { console.log(`${m}:`, JSON.stringify(r, null, 2).slice(0, 1500)); break; }
	}

	// 3. Прямой разворот: оффер 18732/18734 — спросим product.get с разворотом directory?
	console.log('\n=== Значения у офферов (raw) ===');
	for (const id of [18732, 18734]) {
		const p = (await call<{ product?: Record<string, unknown> }>('catalog.product.get', { id }))?.product ?? {};
		const pv = (k: string) => (p[k] as { value?: unknown } | undefined)?.value ?? p[k];
		console.log(`  ${id}: Цвет(358)=${pv('property358')} | ЦветКамеры(110)=${pv('property110')} | Модель(360)=${pv('property360')}`);
	}

	// 4. directory "Цвет" — попробуем highload/userfield развороты
	console.log('\n=== Пробы разворота directory "Цвет" ===');
	for (const m of ['userfieldconfig.list', 'highloadblock.list', 'lists.element.get']) {
		const r = await call<unknown>(m, {});
		if (r) console.log(`${m}: OK →`, JSON.stringify(r, null, 2).slice(0, 600));
	}

	console.log('\nГОТОВО — ничего не записано');
}
main().catch((err) => { console.error(err); process.exit(1); });
