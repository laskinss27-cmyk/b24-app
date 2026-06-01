/**
 * Read-only: чем РЕАЛЬНО различаются SKU-дубли. Первый прогон показал, что ключ —
 * property360 (артикул/модель варианта), не цвет. Здесь: достаём имена свойств
 * (полный список) и меряем охват property360/350/374 по торговым предложениям.
 * Ничего не пишем.  npx tsx scripts/recon-offers.ts
 */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан в .env');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function hr(t: string): void {
	console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
}
async function tryCall<T>(method: string, params: Record<string, unknown> = {}): Promise<T | null> {
	try {
		return await client.call<T>(method, params);
	} catch (err) {
		console.log(`  ⛔ ${method} → ${err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err)}`);
		return null;
	}
}
function enumOrVal(v: unknown): string | null {
	if (v == null) return null;
	if (typeof v === 'object') {
		const o = v as Record<string, unknown>;
		const s = o['valueEnum'] ?? o['value'];
		return s != null && s !== '' ? String(s) : null;
	}
	return v !== '' ? String(v) : null;
}

async function main(): Promise<void> {
	// 1. Имена свойств — пробуем достать по разным iblock (offer-свойства живут отдельно)
	hr('1. ИМЕНА СВОЙСТВ — ищем, что такое property360/350/374');
	const propNames: Record<string, string> = {};
	for (const ib of [0, 26, 27, 28, 29, 30, 31]) {
		const params = ib ? { filter: { iblockId: ib } } : {};
		const list = await tryCall<Array<Record<string, unknown>>>('crm.product.property.list', params);
		if (list && list.length) {
			console.log(`  iblock ${ib || '(все)'}: свойств ${list.length}`);
			for (const p of list) {
				const id = `property${p['ID']}`;
				if (!propNames[id]) propNames[id] = String(p['NAME']);
			}
		}
	}
	for (const id of ['property350', 'property358', 'property360', 'property364', 'property374']) {
		console.log(`  ${id} → «${propNames[id] ?? '??? (имя не нашли)'}»`);
	}

	// 2. Охват ключевых offer-свойств по торговым предложениям (parentId != null)
	hr('2. ОХВАТ property360/350/374 ПО ТОРГОВЫМ ПРЕДЛОЖЕНИЯМ (выборка)');
	const keys = ['property360', 'property350', 'property374'];
	let offers = 0;
	let simple = 0;
	const filled: Record<string, number> = { property360: 0, property350: 0, property374: 0 };
	for (let start = 0; start < 800; start += 50) {
		const list = await tryCall<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
			select: ['id', 'iblockId', 'name', 'parentId', ...keys],
			filter: { iblockId: 26 },
			start,
		});
		const arr = list?.products ?? [];
		if (!arr.length) break;
		for (const pr of arr) {
			const parent = pr['parentId'] as Record<string, unknown> | null | undefined;
			const isOffer = parent != null && parent['value'] != null && parent['value'] !== '' && parent['value'] !== 0;
			if (!isOffer) {
				simple++;
				continue;
			}
			offers++;
			for (const k of keys) if (enumOrVal(pr[k])) filled[k]++;
		}
	}
	const pct = (n: number): string => (offers ? `${Math.round((n / offers) * 100)}% (${n}/${offers})` : '0');
	console.log(`торговых предложений: ${offers}; простых товаров (без parentId): ${simple}`);
	for (const k of keys) console.log(`  «${propNames[k] ?? k}» (${k}): ${pct(filled[k])}`);

	hr('ГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
