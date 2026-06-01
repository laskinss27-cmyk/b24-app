/**
 * Read-only разведка: КАК «пишется» товар в каталоге — какие поля есть и чем
 * реально заполнены. Цель — понять, что вынести в строку отчёта инвентаризации
 * для однозначной идентификации (одно название в каше похожих — мало). Ничего не пишем.
 *
 * npx tsx scripts/recon-product.ts
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
function j(label: string, data: unknown): void {
	let s = JSON.stringify(data, null, 2);
	if (s && s.length > 5000) s = s.slice(0, 5000) + `\n…(обрезано, всего ${s.length})`;
	console.log(`${label}:\n${s}`);
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
	// 1. Схема полей товара — что ВООБЩЕ есть в каталоге
	hr('1. СХЕМА ПОЛЕЙ ТОВАРА (catalog.product.getFields)');
	const fields = await tryCall<{ fields?: Record<string, unknown> }>('catalog.product.getFields', {});
	if (fields?.fields) {
		const names = Object.keys(fields.fields);
		console.log(`полей: ${names.length}`);
		console.log(names.join(', '));
	}

	// 2. Разделы каталога — есть ли осмысленная категоризация
	hr('2. РАЗДЕЛЫ (catalog.section.list)');
	const secs = await tryCall<{ sections?: Array<Record<string, unknown>> }>('catalog.section.list', {
		select: ['id', 'name', 'iblockSectionId'],
		order: { id: 'ASC' },
	});
	const sections = secs?.sections ?? [];
	console.log(`разделов: ${sections.length}`);
	j('первые 30 разделов', sections.slice(0, 30).map((s) => ({ id: s['id'], name: s['name'], parent: s['iblockSectionId'] })));
	const secName = new Map<number, string>();
	for (const s of sections) secName.set(Number(s['id']), String(s['name'] ?? ''));

	// 3. Единицы измерения
	hr('3. ЕДИНИЦЫ ИЗМЕРЕНИЯ (catalog.measure.list)');
	const meas = await tryCall<{ measures?: Array<Record<string, unknown>> }>('catalog.measure.list', {});
	j('measures', (meas?.measures ?? []).map((m) => ({ id: m['id'], code: m['code'], symbol: m['symbolRus'] ?? m['measureTitle'] ?? m['symbol'] })));

	// 4. Берём реальные товары С ОДНОГО СКЛАДА (как при инвентаризации)
	hr('4. ТОВАРЫ С РЕАЛЬНОГО СКЛАДА (storeproduct.list → product.get)');
	const stores = await tryCall<{ stores?: Array<Record<string, unknown>> }>('catalog.store.list', {
		select: ['id', 'title', 'active'],
		order: { id: 'ASC' },
	});
	const store = (stores?.stores ?? []).find((s) => s['active'] === 'Y') ?? (stores?.stores ?? [])[0];
	const storeId = store ? Number(store['id']) : null;
	console.log(`склад: #${storeId} ${store?.['title'] ?? ''}`);

	let productIds: number[] = [];
	if (storeId != null) {
		const sp = await tryCall<{ storeProducts?: Array<Record<string, unknown>> }>('catalog.storeproduct.list', {
			filter: { storeId },
			select: ['productId', 'amount'],
		});
		productIds = [...new Set((sp?.storeProducts ?? []).map((x) => Number(x['productId'])).filter((x) => x > 0))].slice(0, 10);
	}
	console.log(`беру товаров: ${productIds.length} → ${productIds.join(', ')}`);

	// 5. По каждому — нативные поля (catalog) + кастомные свойства (crm)
	hr('5. ИДЕНТИФИКАЦИЯ ПО КАЖДОМУ ТОВАРУ (catalog.product.get + crm.product.get)');
	const batch: Record<string, { method: string; params: Record<string, unknown> }> = {};
	for (const pid of productIds) {
		batch[`cat${pid}`] = { method: 'catalog.product.get', params: { id: pid } };
		batch[`crm${pid}`] = { method: 'crm.product.get', params: { id: pid } };
	}
	const res = productIds.length ? await client.callBatch(batch).catch(() => null) : null;
	let firstRawShown = false;
	for (const pid of productIds) {
		const catP = (res?.result[`cat${pid}`] as { product?: Record<string, unknown> } | undefined)?.product;
		const crmP = res?.result[`crm${pid}`] as Record<string, unknown> | undefined;
		const props: Record<string, unknown> = {};
		if (crmP) {
			for (const [k, v] of Object.entries(crmP)) {
				if (k.startsWith('PROPERTY_') && v != null && v !== '' && JSON.stringify(v) !== '[]') props[k] = v;
			}
		}
		const sid = Number(catP?.['iblockSectionId'] ?? catP?.['sectionId']);
		console.log(`\n— #${pid} —`);
		console.log(`  name:    ${JSON.stringify(catP?.['name'])}`);
		console.log(`  code:    ${JSON.stringify(catP?.['code'])}   xmlId: ${JSON.stringify(catP?.['xmlId'])}`);
		console.log(`  barcode: ${JSON.stringify(catP?.['barcode'])}`);
		console.log(`  section: ${JSON.stringify(sid)} (${secName.get(sid) ?? '?'})`);
		console.log(`  measure: ${JSON.stringify(catP?.['measure'])}`);
		console.log(`  preview: ${JSON.stringify(catP?.['previewPicture'])}   detail: ${JSON.stringify(catP?.['detailPicture'])}`);
		if (Object.keys(props).length) j('  заполненные PROPERTY_*', props);
		// первый товар — целиком, чтобы видеть ВСЕ поля что отдаёт API
		if (!firstRawShown && catP) {
			j('  >>> ПЕРВЫЙ ТОВАР ЦЕЛИКОМ (все поля catalog.product.get)', catP);
			firstRawShown = true;
		}
	}

	hr('ГОТОВО — ничего не записано');
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
