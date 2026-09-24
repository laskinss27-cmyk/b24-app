import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const kind = args.get('kind') ?? 'camera';
if (!['camera', 'recorder'].includes(kind)) throw new Error(`Unsupported kind ${kind}`);
const categoryKey = kind === 'recorder' ? 'video_recorder' : 'camera';
const outputPath = path.resolve(args.get('output') ?? `work-catalog-video-20260728/${kind}-master.json`);
const scope = JSON.parse(await fs.readFile(path.resolve(args.get('scope') ?? 'work-catalog-video-20260728/scope.json'), 'utf8'));
const packagePaths = String(args.get('packages') ?? '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean)
	.map((value) => path.resolve(value));
const appliedPaths = String(args.get('applied') ?? '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean)
	.map((value) => path.resolve(value));

const scopedRows = scope.rows.filter((row) => row.kind === kind);
const rowsById = new Map(scopedRows.filter((row) => row.id != null).map((row) => [Number(row.id), row]));
const productIds = new Set();
const products = [];
const duplicatePreparedIds = [];
const packageBlocked = [];
const sourcePackages = [];

for (const packagePath of packagePaths) {
	const catalog = JSON.parse(await fs.readFile(packagePath, 'utf8'));
	sourcePackages.push({
		path: path.relative(process.cwd(), packagePath).replaceAll('\\', '/'),
		vendor: catalog.vendor,
	});
	for (const product of catalog.products ?? []) {
		if (product.categoryKey !== categoryKey) continue;
		const id = Number(product.productId);
		if (!rowsById.has(id)) continue;
		const filterableCount = (product.attributes ?? []).filter((attribute) => attribute.filterable).length;
		const minimumFilterableCount = kind === 'recorder' ? 2 : 1;
		if (filterableCount < minimumFilterableCount) {
			packageBlocked.push({
				productId: id,
				reason: 'Официальная страница подтверждает модель, но не даёт достаточно структурированных характеристик для будущих фильтров; существующая карточка сохраняется.',
				sourcePackage: path.relative(process.cwd(), packagePath).replaceAll('\\', '/'),
			});
			continue;
		}
		if (productIds.has(id)) {
			duplicatePreparedIds.push(id);
			continue;
		}
		productIds.add(id);
		products.push({ ...product, sourcePackage: path.relative(process.cwd(), packagePath).replaceAll('\\', '/') });
	}
	for (const blocked of catalog.blocked ?? []) {
		const id = Number(blocked.productId);
		if (rowsById.has(id)) packageBlocked.push({ ...blocked, sourcePackage: path.relative(process.cwd(), packagePath).replaceAll('\\', '/') });
	}
}

const appliedIds = new Set();
const applied = [];
for (const packagePath of appliedPaths) {
	const catalog = JSON.parse(await fs.readFile(packagePath, 'utf8'));
	for (const product of catalog.products ?? []) {
		if (product.categoryKey !== categoryKey) continue;
		const id = Number(product.productId);
		if (!rowsById.has(id) || appliedIds.has(id)) continue;
		appliedIds.add(id);
		applied.push({
			productId: id,
			name: rowsById.get(id).name,
			sourcePackage: path.relative(process.cwd(), packagePath).replaceAll('\\', '/'),
		});
	}
}

const excludeRules = kind === 'camera'
	? [
		[/\u043f\u0435\u0440\u0435\u043d\u043e\u0441\s+\u043a\u0430\u043c\u0435\u0440/iu, 'Служебная строка переноса камеры, а не товар.'],
		[/\u0432\u044b\u0437\u044b\u0432\u043d\S*\s+\u043f\u0430\u043d\u0435\u043b|\u0432\u0438\u0434\u0435\u043e\u0434\u043e\u043c\u043e\u0444\u043e\u043d|\u0434\u043e\u043c\u043e\u0444\u043e\u043d/iu, 'Домофонное оборудование, а не камера видеонаблюдения.'],
		[/\[ремонт\]|(?:^|\s)ремонт(?:\s|$)/iu, 'Ремонтная/служебная строка, а не товарная камера.'],
		[/кронштейн|монтажн\w*\s+короб|креплени|адаптер.*камер/iu, 'Аксессуар для монтажа, а не камера.'],
		[/датчик.*(?:фото|видео)камер|датчик движения/iu, 'Охранный датчик с фотокамерой, а не камера видеонаблюдения.'],
		[/муляж|макет.*камер/iu, 'Муляж камеры, без видеонаблюдения.'],
		[/видеодомофон|вызывн\w*\s+панел|интерком/iu, 'Домофонное оборудование, а не камера видеонаблюдения.'],
		[/услуг|работ\w*\s+по|настройк|монтаж|аренд/iu, 'Услуга, а не оборудование.'],
	]
	: [
		[/услуг|работ\w*\s+по|настройк|монтаж|аренд|ремонт/iu, 'Услуга/служебная строка, а не видеорегистратор.'],
		[/жестк\w*\s+диск|накопител|hdd\b|ssd\b/iu, 'Накопитель или аксессуар, а не видеорегистратор.'],
		[/software|licen[cs]e|\u043f\u0440\u043e\u0433\u0440\u0430\u043c\u043c\u043d\u043e\u0435\s+\u043e\u0431\u0435\u0441\u043f\u0435\u0447\u0435\u043d/iu, 'Программное обеспечение или лицензия, а не видеорегистратор.'],
		[/\u0443\u0441\u0442\u0430\u043d\u043e\u0432\u043a[\u0430-\u044f\u0451]*\s+\u0438\s+\u043f\u043e\u0434\u043a\u043b\u044e\u0447\u0435\u043d/iu, 'Услуга установки и подключения, а не видеорегистратор.'],
		[/\u043d\u0430\u0441\u0442\u043e\u0439\u043a[\u0430-\u044f\u0451]*\s+\u0441\u0438\u0441\u0442\u0435\u043c/iu, 'Услуга настройки, а не видеорегистратор.'],
		[/antenna|\u0430\u043d\u0442\u0435\u043d\w*/iu, 'Антенна или иной аксессуар, а не видеорегистратор.'],
		[/\u043a\u043e\u043c\u043f\u043b\u0435\u043a\u0442.*(?:\u043a\u0430\u043c\u0435\u0440|\u0432\u0438\u0434\u0435\u043e\u043d\u0430\u0431\u043b\u044e\u0434\u0435\u043d)/iu, 'Комплект видеонаблюдения, а не отдельный видеорегистратор.'],
	];

const excluded = [];
const blockedById = new Map();
for (const entry of packageBlocked) {
	const id = Number(entry.productId);
	if (!productIds.has(id) && !appliedIds.has(id) && !blockedById.has(id)) {
		blockedById.set(id, {
			productId: id,
			name: rowsById.get(id)?.name ?? entry.name ?? entry.currentName,
			model: rowsById.get(id)?.model ?? entry.model ?? '',
			brand: rowsById.get(id)?.brand ?? '',
			reason: entry.reason,
			sourcePackage: entry.sourcePackage,
		});
	}
}

for (const row of scopedRows) {
	if (row.id == null) {
		excluded.push({ productId: null, name: row.name, reason: 'Строка без идентификатора ERPNext; не является безопасной целью обновления.' });
		continue;
	}
	const id = Number(row.id);
	if (productIds.has(id) || appliedIds.has(id) || blockedById.has(id)) continue;
	const haystack = `${row.name} ${row.model} ${row.article}`;
	const exclusion = excludeRules.find(([pattern]) => pattern.test(haystack));
	if (exclusion) {
		excluded.push({ productId: id, name: row.name, reason: exclusion[1] });
		continue;
	}
	const brand = row.brand || 'не указан';
	blockedById.set(id, {
		productId: id,
		name: row.name,
		model: row.model,
		brand: row.brand,
		reason: `Точная официальная карточка модели ${row.model || row.name} у производителя «${brand}» не подтверждена. Существующие данные не заменяются предположениями или данными дилеров.`,
	});
}

const blocked = [...blockedById.values()].sort((a, b) => a.productId - b.productId);
products.sort((a, b) => a.productId - b.productId);
applied.sort((a, b) => a.productId - b.productId);
excluded.sort((a, b) => (a.productId ?? -1) - (b.productId ?? -1));
const classified = products.length + applied.length + blocked.length + excluded.length;
const externalOrigins = new Set();
for (const product of products) {
	for (const sourceUrl of product.sourceUrls ?? []) {
		try {
			externalOrigins.add(new URL(sourceUrl).hostname.toLowerCase());
		} catch {
			// Invalid sources are reported by QA below.
		}
	}
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	kind,
	scope: {
		total: scopedRows.length,
		prepared: products.length,
		alreadyApplied: applied.length,
		blocked: blocked.length,
		excluded: excluded.length,
		classified,
	},
	products,
	alreadyApplied: applied,
	blocked,
	excluded,
	sourcePackages,
	qa: {
		completeClassification: classified === scopedRows.length,
		duplicatePreparedIds: [...new Set(duplicatePreparedIds)].sort((a, b) => a - b),
		preparedMissingSource: products.filter((product) => !(product.sourceUrls?.length)).map((product) => product.productId),
		preparedMissingAttributes: products.filter((product) => !(product.attributes?.length)).map((product) => product.productId),
		preparedMissingFilterableAttributes: products
			.filter((product) => !(product.attributes ?? []).some((attribute) => attribute.filterable))
			.map((product) => product.productId),
		sourceOrigins: [...externalOrigins].sort(),
	},
};

if (!result.qa.completeClassification) throw new Error(`Classification incomplete: ${classified}/${scopedRows.length}`);
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, scope: result.scope, qa: result.qa }, null, 2));
