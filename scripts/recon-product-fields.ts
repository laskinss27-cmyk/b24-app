/**
 * Read-only: имена свойств товара + РЕАЛЬНАЯ заполненность ключевых полей
 * (модель / производитель / бренд / артикул) по большой выборке каталога.
 * Проверяем гипотезу «модель есть у всех». Ничего не пишем.
 *
 * npx tsx scripts/recon-product-fields.ts
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

async function main(): Promise<void> {
	// 1. Имена свойств товаров (что вообще есть и как называется)
	hr('1. СВОЙСТВА ТОВАРА (crm.product.property.list)');
	let propsRaw = await tryCall<Array<Record<string, unknown>>>('crm.product.property.list', { filter: { iblockId: 26 } });
	if (!propsRaw || !propsRaw.length) propsRaw = await tryCall<Array<Record<string, unknown>>>('crm.product.property.list', {});
	const props = propsRaw ?? [];
	console.log(`свойств: ${props.length}`);
	for (const p of props) {
		console.log(`  PROPERTY_${p['ID']}  «${p['NAME']}»  type=${p['PROPERTY_TYPE']}  code=${p['CODE'] ?? ''}`);
	}

	// меряем заполненность ВСЕХ свойств — полная карта, чтобы выбрать идентификаторы по факту
	const targets = props.map((p) => ({ id: Number(p['ID']), name: String(p['NAME']) }));
	console.log('\nмеряю заполненность всех свойств по выборке…');

	// 2. Заполненность по выборке (crm.product.list отдаёт PROPERTY_*, пагинация инкрементом)
	hr('2. ЗАПОЛНЕННОСТЬ ПО ВЫБОРКЕ (crm.product.list, до ~500 товаров)');
	const fieldKeys = targets.map((t) => `PROPERTY_${t.id}`);
	const select = ['ID', 'NAME', 'SECTION_ID', ...fieldKeys];
	let total = 0;
	const filled: Record<string, number> = {};
	for (const k of [...fieldKeys, 'SECTION_ID']) filled[k] = 0;

	for (let start = 0; start < 500; start += 50) {
		const list = await tryCall<Array<Record<string, unknown>>>('crm.product.list', { select, order: { ID: 'ASC' }, start });
		if (!list || !list.length) break;
		for (const pr of list) {
			total++;
			for (const f of fieldKeys) {
				const v = pr[f];
				if (v != null && v !== '' && JSON.stringify(v) !== '[]' && JSON.stringify(v) !== '{}') filled[f]++;
			}
			const sid = pr['SECTION_ID'];
			if (sid != null && sid !== '' && sid !== 0 && sid !== '0') filled['SECTION_ID']++;
		}
	}

	const pct = (n: number): string => (total ? `${Math.round((n / total) * 100)}% (${n}/${total})` : '0');
	console.log(`\nпросмотрено товаров: ${total}\n`);
	const rows = targets.map((t) => ({ label: `«${t.name}» (PROPERTY_${t.id})`, n: filled[`PROPERTY_${t.id}`] ?? 0 }));
	rows.push({ label: 'РАЗДЕЛ (SECTION_ID)', n: filled['SECTION_ID'] });
	rows.sort((a, b) => b.n - a.n);
	for (const r of rows) console.log(`  ${pct(r.n).padStart(13)}  ${r.label}`);

	hr('ГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
