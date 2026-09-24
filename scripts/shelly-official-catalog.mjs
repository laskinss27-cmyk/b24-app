import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const rootDir = process.cwd();
const corePath = path.resolve(args.get('core')
	?? 'outputs/019f9333-product-enrichment/core-current.json');
const catalogPath = path.resolve(args.get('catalog')
	?? 'outputs/019f9bff-filter-ready-catalog/filter-ready-catalog.json');
const schemaPath = path.resolve(args.get('schema')
	?? 'outputs/019f9bff-filter-ready-catalog/filter-attribute-schema.json');
const researchDir = path.resolve(args.get('research-dir')
	?? 'outputs/019f9333-product-enrichment');
const outDir = path.resolve(args.get('out')
	?? 'local-artifacts/shelly-official-catalog');
const downloadImages = (args.get('download-images') ?? 'yes') === 'yes';
const resume = (args.get('resume') ?? 'no') === 'yes';
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 4));
const requestDelayMs = Math.max(0, Number(args.get('request-delay-ms') ?? 250));

const researchFiles = [
	'shelly-stock-descriptions.json',
	'shelly-stage-2-descriptions.json',
	'shelly-stage-3-descriptions.json',
	'shelly-remaining-descriptions.json',
];

const sourceOverrides = new Map([
	[18126, 'https://www.shelly.com/products/shelly-em-50a-clamp-1'],
	[18136, 'https://www.shelly.com/products/shelly-button-add-on'],
	[18162, 'https://www.shelly.com/products/shelly-vintage-st64'],
	[18166, 'https://www.shelly.com/products/shelly-vintage-g125'],
	[18168, 'https://www.shelly.com/products/shelly-vintage-a60'],
	[18182, 'https://www.shelly.com/products/shelly-h-t-white'],
	[18214, 'https://www.shelly.com/products/shelly-motion-2'],
	[18216, 'https://www.shelly.com/products/shelly-h-t-black'],
	[18208, 'https://www.shelly.com/products/shelly-temp-sensor-ds18b20-1m-cable'],
	[18210, 'https://www.shelly.com/products/shelly-temp-sensor-ds18b20-1m-cable'],
	[18220, 'https://www.shelly.com/products/shelly-gas-sensor-cng'],
	[18232, 'https://www.shelly.com/products/shelly-1pm-gen4'],
	[18244, 'https://www.shelly.com/blogs/documentation/shelly-1l-gen3'],
	[18264, 'https://www.shelly.com/products/shelly-120a-current-transf-pro-3em'],
	[18194, 'https://www.shelly.com/products/shelly-h-t-gen3-matte-white'],
	[18218, 'https://www.shelly.com/products/shelly-gas-lpg-2'],
	[18224, 'https://us.shelly.com/blogs/documentation/shelly-door-window-2'],
	[18270, 'https://us.shelly.com/products/current-transformer-50a'],
	[18282, 'https://www.shelly.com/products/shelly-pro-3em-x1'],
	[18298, 'https://www.shelly.com/products/shelly-0-1-10v-dimmer-pm-gen3'],
	[18302, 'https://www.shelly.com/products/shelly-lan-switch'],
	[18324, 'https://www.shelly.com/products/shelly-plus-1-x1'],
	[18342, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-black'],
	[18354, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-white-x3'],
	[18356, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-white-x2'],
	[18364, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-black-x3'],
	[18366, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-black-x2'],
	[18368, 'https://www.shelly.com/products/shelly-frame-for-wall-switch-white'],
	[18360, 'https://www.shelly.com/products/shelly-wall-socket-eu-white'],
	[18362, 'https://www.shelly.com/fr/products/shelly-wall-socket-eu-black'],
]);

const imageUrlOverrides = new Map([
	[18156, 'https://kb.shelly.cloud/__attachments/a_52c49b887de204fc05203d104ec9486ad9aaf308aec2ea58f2be0b9d4b4228fb/shelly-wall-display.jpg?cb=7d29a09dd4f2f73b25722a6b16604bc8'],
	[18214, 'https://www.shelly.com/cdn/shop/files/motionV2_front-625x625.png?v=1729245139&width=1946'],
	[18224, 'https://shelly-api-docs.shelly.cloud/gen1/images/shelly/shellydoorwindow-product-cb9653ab.png'],
	[18230, 'https://kb.shelly.cloud/__attachments/a_cb25aa66719b545430231ca22ce4214909c118ad547aadfce3a6e5b49742e5dc/shelly1.png?cb=d88bc4eb549ecbb6dd307cadbbb3d3a0'],
	[18360, 'https://www.shelly.com/cdn/shop/files/EU-ELECTRICAL-SOCKET-PICTURE-1-2-625x625.webp?v=1726728023&width=1946'],
	[18362, 'https://www.shelly.com/cdn/shop/files/EU-ELECTRICAL-SOCKET-PICTURE-1-625x625.webp?v=1726728066&width=1946'],
]);

const localImageOverrides = new Map([
	[18126, {
		localPath: 'local-artifacts/shelly-official-catalog/images/18126-v2.webp',
		sourceUrl: 'generated-from-user-approved-reference:https://shop-shelly.ru/img/17663181.png',
	}],
	[18154, {
		localPath: 'local-artifacts/shelly-official-catalog/images/18154-v2.webp',
		sourceUrl: 'generated-from-official-shelly-reference:https://www.shelly.com/products/shelly-wall-display-white',
	}],
]);

const blocked = new Map([
	[18414, 'На официальном сайте Shelly не найдена модель DN-HLDx2. Данные и фото не подменяются сведениями продавцов.'],
	[18416, 'На официальном сайте Shelly не найдена модель DN-HLDx2 Plus. Данные и фото не подменяются сведениями продавцов.'],
	[18418, 'На официальном сайте Shelly не найдено соответствующее крепление DIN Holder Mini Single.'],
	[18574, 'Ecowitt WS90 ошибочно находится в разделе/бренде Shelly, но не является товаром Shelly.'],
]);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function mapLimit(values, concurrency, worker) {
	let cursor = 0;
	const results = new Array(values.length);
	await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
		while (cursor < values.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await worker(values[index], index);
		}
	}));
	return results;
}
const readJson = (filePath) => fs.readFile(filePath, 'utf8').then(JSON.parse);
const cleanText = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const officialShellyUrl = (value) => {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return hostname === 'shelly.com' || hostname.endsWith('.shelly.com');
	} catch {
		return false;
	}
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function normalizeImageUrl(value) {
	const text = String(value ?? '').replace(/&amp;/gu, '&');
	if (text.startsWith('//')) return `https:${text}`;
	if (text.startsWith('/')) return `https://www.shelly.com${text}`;
	return text;
}

const colorTokens = [
	[/\b(?:black|ч[её]рн|black matte)\b/iu, ['black', 'matte-black']],
	[/\b(?:white|бел)\b/iu, ['white']],
	[/\b(?:blue|син|голуб)\b/iu, ['blue']],
	[/\b(?:red|красн)\b/iu, ['red']],
	[/\b(?:brown|коричнев)\b/iu, ['brown']],
	[/\b(?:mocha|мокко)\b/iu, ['mocha']],
	[/\b(?:ivory|слонов)\b/iu, ['ivory']],
	[/\b(?:silver|серебр)\b/iu, ['silver']],
];

function imageScore(imageUrl, model) {
	const hay = decodeURIComponent(String(imageUrl)).toLowerCase();
	let score = 0;
	if (/main[-_ ]?image|front[-_ ]?view|product[-_ ]?image/u.test(hay)) score += 25;
	if (/wiring|diagram|installation|lifestyle|bundle|packaging|dimensions|render-scene/u.test(hay)) score -= 30;
	if (/share-general|shelly[_-]academy|solutions?-\d|logo|icon-|payment|trustmark/u.test(hay)) score -= 120;
	for (const [pattern, tokens] of colorTokens) {
		if (!pattern.test(model)) continue;
		score += tokens.some((token) => hay.includes(token)) ? 35 : -5;
	}
	for (const length of ['1', '3']) {
		if (!new RegExp(`\\b${length}\\s*(?:m|м)\\b`, 'iu').test(model)) continue;
		score += new RegExp(`(?:^|[-_ ])${length}(?:m|meter|metre)(?:[-_ .]|$)`, 'iu').test(hay) ? 40 : -5;
	}
	const modelTokens = cleanText(model)
		.toLowerCase()
		.replace(/\bshelly\b/gu, '')
		.split(/[^\p{L}\p{N}]+/gu)
		.filter((token) => token.length >= 2 && !['gen', 'plus', 'white', 'black'].includes(token));
	for (const token of modelTokens) if (hay.includes(token)) score += 2;
	return score;
}

function selectImage(images, model) {
	const candidatesByUrl = new Map();
	for (const image of images) {
		const url = normalizeImageUrl(typeof image === 'string' ? image : image?.url);
		if (!url) continue;
		const context = cleanText(typeof image === 'string' ? '' : image?.context);
		candidatesByUrl.set(url, `${candidatesByUrl.get(url) ?? ''} ${context}`.trim());
	}
	const candidates = [...candidatesByUrl].map(([url, context]) => ({ url, context }));
	return candidates
		.map(({ url, context }, index) => ({
			url,
			score: imageScore(`${url} ${context}`, model) - index / 1000,
		}))
		.sort((left, right) => right.score - left.score)[0]?.url ?? '';
}

async function fetchWithRetry(url, responseType = 'text') {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				redirect: 'follow',
				headers: {
					'user-agent': 'b24-app-shelly-catalog-audit/1.0',
					accept: responseType === 'buffer'
						? 'image/avif,image/webp,image/png,image/jpeg,*/*'
						: 'application/json,text/html;q=0.9,*/*;q=0.8',
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			if (responseType === 'buffer') return {
				value: Buffer.from(await response.arrayBuffer()),
				finalUrl: response.url,
				contentType: response.headers.get('content-type') ?? '',
			};
			return {
				value: await response.text(),
				finalUrl: response.url,
				contentType: response.headers.get('content-type') ?? '',
			};
		} catch (error) {
			lastError = error;
			await sleep(attempt * 750);
		}
	}
	throw new Error(`${url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function imagesFromHtml(html) {
	const output = [];
	for (const match of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/giu)) {
		output.push({ url: match[1], context: 'social preview' });
	}
	for (const match of html.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/giu)) {
		output.push({ url: match[1], context: 'social preview' });
	}
	for (const tagMatch of html.matchAll(/<img\b[^>]*>/giu)) {
		const tag = tagMatch[0];
		const source = tag.match(/(?:src|data-src)=["']([^"']+\.(?:png|jpe?g|webp)(?:\?[^"']*)?)/iu)?.[1];
		if (!source) continue;
		const alt = tag.match(/\balt=["']([^"']*)/iu)?.[1] ?? '';
		output.push({ url: source, context: alt });
	}
	return output;
}

async function officialPageData(sourceUrl, model) {
	if (!officialShellyUrl(sourceUrl)) throw new Error('Источник не относится к официальному сайту Shelly');
	const source = new URL(sourceUrl);
	source.search = '';
	source.hash = '';
	let pageTitle = '';
	let sku = '';
	let images = [];
	let finalSourceUrl = source.toString();

	if (source.pathname.includes('/products/')) {
		const productUrl = new URL(source);
		productUrl.pathname = `${productUrl.pathname.replace(/\/$/u, '')}.js`;
		try {
			const fetched = await fetchWithRetry(productUrl.toString());
			const product = JSON.parse(fetched.value);
			pageTitle = cleanText(product.title);
			images = [
				...(product.images ?? []),
				...(product.media ?? []).map((entry) => entry?.src ?? entry?.preview_image?.src),
				product.featured_image,
			].filter(Boolean);
			const matchingVariant = (product.variants ?? [])
				.map((variant) => ({
					variant,
					score: imageScore(`${variant.title} ${variant.name}`, model),
				}))
				.sort((left, right) => right.score - left.score)[0]?.variant;
			sku = cleanText(matchingVariant?.sku);
		} catch {
			// Some retired product slugs expose only the rendered product/documentation page.
		}
	}

	if (!images.length) {
		const fetched = await fetchWithRetry(source.toString());
		finalSourceUrl = fetched.finalUrl;
		const titleMatch = fetched.value.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
		pageTitle = cleanText(titleMatch?.[1] ?? pageTitle);
		images = imagesFromHtml(fetched.value);
	}

	return {
		sourceUrl: finalSourceUrl,
		pageTitle,
		sku,
		imageUrl: selectImage(images, model),
		imageCandidates: images.length,
	};
}

function setAttribute(product, label, patch) {
	const attribute = product.attributes.find((entry) => cleanText(entry.label) === label);
	if (!attribute) throw new Error(`${product.productId}: attribute "${label}" not found`);
	Object.assign(attribute, patch);
}

function readyOption(product, label, key, value, booleanValue = null) {
	const patch = {
		key,
		label,
		sourceLabel: label,
		group: key === 'compatibility' ? 'Совместимость' : 'Электрика',
		type: booleanValue == null ? 'multi_option' : 'option',
		rawValue: value,
		normalizedValue: value,
		numberValue: null,
		numberMin: null,
		numberMax: null,
		unit: '',
		booleanValue,
		filterable: true,
		status: 'Готово для фильтра',
	};
	const attribute = product.attributes.find((entry) => cleanText(entry.label) === label);
	if (attribute) Object.assign(attribute, patch);
	else product.attributes.push({ order: product.attributes.length + 1, ...patch });
}

function displayOnly(product, label, value) {
	setAttribute(product, label, {
		rawValue: value,
		normalizedValue: value,
		filterable: false,
		status: 'Только для отображения',
	});
}

function addNumberAttribute(product, {
	key, label, group, value, rawValue = String(value), unit = '',
}) {
	const existing = product.attributes.find((entry) => entry.key === key);
	const patch = {
		order: existing?.order ?? product.attributes.length + 1,
		key,
		label,
		sourceLabel: label,
		group,
		type: 'number',
		rawValue,
		normalizedValue: String(value),
		numberValue: value,
		numberMin: null,
		numberMax: null,
		unit,
		booleanValue: null,
		filterable: true,
		status: 'Готово для фильтра',
	};
	if (existing) Object.assign(existing, patch);
	else product.attributes.push(patch);
}

function officialAttribute({
	key,
	label,
	value,
	group,
	type = 'option',
	numberValue = null,
	unit = '',
	booleanValue = null,
	filterable = true,
}) {
	return {
		order: 0,
		key,
		label,
		sourceLabel: label,
		group,
		type,
		rawValue: value,
		normalizedValue: numberValue == null ? value : String(numberValue),
		numberValue,
		numberMin: null,
		numberMax: null,
		unit,
		booleanValue,
		filterable,
		status: filterable ? 'Готово для фильтра' : 'Только для отображения',
	};
}

const correctedOfficialAttributes = new Map([
	[18208, [
		officialAttribute({ key: 'product_type', label: 'Тип', value: 'Датчик температуры DS18B20', group: 'Идентификация' }),
		officialAttribute({ key: 'connection', label: 'Подключение', value: '1-Wire', group: 'Подключения' }),
		officialAttribute({ key: 'length', label: 'Длина кабеля', value: '3 м', group: 'Размеры', type: 'number', numberValue: 3, unit: 'м' }),
		officialAttribute({ key: 'compatibility', label: 'Совместимость', value: 'Shelly Plus Add-on', group: 'Совместимость', type: 'multi_option' }),
	]],
	[18210, [
		officialAttribute({ key: 'product_type', label: 'Тип', value: 'Датчик температуры DS18B20', group: 'Идентификация' }),
		officialAttribute({ key: 'connection', label: 'Подключение', value: '1-Wire', group: 'Подключения' }),
		officialAttribute({ key: 'length', label: 'Длина кабеля', value: '1 м', group: 'Размеры', type: 'number', numberValue: 1, unit: 'м' }),
		officialAttribute({ key: 'compatibility', label: 'Совместимость', value: 'Shelly Plus Add-on', group: 'Совместимость', type: 'multi_option' }),
	]],
	[18296, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'neutral_required', label: 'Нейтраль', value: 'Не требуется', group: 'Электрика', booleanValue: false }),
		officialAttribute({ key: 'power', label: 'Максимальная мощность', value: 'до 200 Вт', group: 'Электрика', type: 'number', numberValue: 200, unit: 'Вт' }),
		officialAttribute({ key: 'dimming_type', label: 'Тип диммирования', value: 'Trailing edge', group: 'Электрика' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '38 × 42,5 × 16,5 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18298, [
		officialAttribute({ key: 'product_type', label: 'Тип', value: 'Диммер 0/1–10 В', group: 'Идентификация' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth; Matter после обновления', group: 'Подключения', type: 'multi_option' }),
	]],
	[18300, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '5', group: 'Подключения', type: 'number', numberValue: 5 }),
		officialAttribute({ key: 'feature', label: 'Профили работы', value: 'CCT × 2; RGB+CCT; RGB+2 света; 5 независимых каналов', group: 'Дополнительно', type: 'text', filterable: false }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18304, [
		officialAttribute({ key: 'channels_count', label: 'Количество приводов', value: '2', group: 'Подключения', type: 'number', numberValue: 2 }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: '16 А на выход', group: 'Электрика', type: 'number', numberValue: 16, unit: 'А' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да, отдельно по каждому приводу', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18306, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '2', group: 'Подключения', type: 'number', numberValue: 2 }),
		officialAttribute({ key: 'power', label: 'Максимальная мощность', value: 'до 200 Вт на канал', group: 'Электрика', type: 'number', numberValue: 200, unit: 'Вт' }),
		officialAttribute({ key: 'dimming_type', label: 'Тип диммирования', value: 'Trailing edge', group: 'Электрика' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18308, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18310, [
		officialAttribute({ key: 'product_type', label: 'Тип', value: 'Диммер 0/1–10 В', group: 'Идентификация' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18314, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '2', group: 'Подключения', type: 'number', numberValue: 2 }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: '16 А на канал; до 25 А суммарно', group: 'Электрика', type: 'number', numberValue: 16, unit: 'А' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18316, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '2', group: 'Подключения', type: 'number', numberValue: 2 }),
		officialAttribute({ key: 'dry_contact', label: 'Сухой контакт', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18318, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'dry_contact', label: 'Сухой контакт', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 16 А', group: 'Электрика', type: 'number', numberValue: 16, unit: 'А' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'DIN-рейка', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Подключение', value: 'Ethernet; Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18320, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '2', group: 'Подключения', type: 'number', numberValue: 2 }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: '10 А на канал; до 16 А суммарно', group: 'Электрика', type: 'number', numberValue: 10, unit: 'А' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
	]],
	[18322, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 16 А', group: 'Электрика', type: 'number', numberValue: 16, unit: 'А' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '37 × 42 × 16 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18324, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'dry_contact', label: 'Сухой контакт', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 16 А', group: 'Электрика', type: 'number', numberValue: 16, unit: 'А' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '37 × 42 × 16 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18334, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 8 А', group: 'Электрика', type: 'number', numberValue: 8, unit: 'А' }),
		officialAttribute({ key: 'power_measurement', label: 'Измерение мощности', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi 6; Bluetooth 5; Zigbee; Matter', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '29 × 34 × 16 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18336, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'dry_contact', label: 'Сухой контакт', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 8 А', group: 'Электрика', type: 'number', numberValue: 8, unit: 'А' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi 6; Bluetooth 5; Zigbee; Matter', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '29 × 34 × 16 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18338, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'dry_contact', label: 'Сухой контакт', value: 'Да', group: 'Электрика', booleanValue: true }),
		officialAttribute({ key: 'max_current', label: 'Максимальный ток', value: 'до 8 А', group: 'Электрика', type: 'number', numberValue: 8, unit: 'А' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth; Matter после обновления', group: 'Подключения', type: 'multi_option' }),
		officialAttribute({ key: 'dimensions', label: 'Габариты', value: '29 × 34 × 16 мм', group: 'Размеры', type: 'text', filterable: false }),
	]],
	[18578, [
		officialAttribute({ key: 'channels_count', label: 'Количество каналов', value: '1', group: 'Подключения', type: 'number', numberValue: 1 }),
		officialAttribute({ key: 'neutral_required', label: 'Нейтраль', value: 'Не требуется', group: 'Электрика', booleanValue: false }),
		officialAttribute({ key: 'power', label: 'Максимальная мощность', value: 'до 200 Вт', group: 'Электрика', type: 'number', numberValue: 200, unit: 'Вт' }),
		officialAttribute({ key: 'dimming_type', label: 'Тип диммирования', value: 'Trailing edge', group: 'Электрика' }),
		officialAttribute({ key: 'mounting_type', label: 'Монтаж', value: 'Скрытый, в стену', group: 'Исполнение' }),
		officialAttribute({ key: 'wireless', label: 'Беспроводная связь', value: 'Wi‑Fi; Bluetooth; Zigbee; Matter', group: 'Подключения', type: 'multi_option' }),
	]],
]);

function applyOfficialCorrections(product) {
	const corrected = correctedOfficialAttributes.get(product.productId);
	if (corrected) product.attributes = corrected.map((attribute) => ({ ...attribute }));

	switch (product.productId) {
		case 18244:
			readyOption(product, 'Нейтраль', 'neutral_required', 'Не требуется', false);
			displayOnly(product, 'Важно', 'Shelly Bypass требуется для нагрузки на выходе O и входит в комплект');
			break;
		case 18332:
			readyOption(product, 'Нейтраль', 'neutral_required', 'Не требуется', false);
			break;
		case 18426:
		case 18232:
			readyOption(product, 'Нейтраль', 'neutral_required', 'Требуется', true);
			break;
		case 18154:
		case 18156:
			setAttribute(product, 'Питание', { status: 'Готово для фильтра', filterable: true });
			break;
		case 18264:
			readyOption(product, 'Совместимость', 'compatibility', 'Shelly Pro 3EM 120A; Shelly EM Gen4');
			break;
		case 18292:
		case 18294:
			displayOnly(product, 'Трансформаторы тока', '1 × трансформатор тока 50 А входит в комплект');
			break;
		case 18282:
			displayOnly(product, 'Архив', 'до 60 дней с шагом 1 минута');
			break;
		case 18302:
			product.title = 'Неуправляемый Ethernet-коммутатор Shelly LAN Switch для DIN-рейки';
			product.shortDescription = 'Пятипортовый неуправляемый Ethernet-коммутатор 10/100 Мбит/с для установки на DIN-рейку. Питается напрямую от сети 110–240 В AC и не требует отдельного адаптера.';
			product.attributes = [];
			addNumberAttribute(product, {
				key: 'ports_count', label: 'Количество портов', group: 'Подключения', value: 5,
			});
			addNumberAttribute(product, {
				key: 'ethernet_speed', label: 'Скорость Ethernet', group: 'Подключения',
				value: 100, rawValue: '10/100 Мбит/с', unit: 'Мбит/с',
			});
			product.attributes.push({
				order: 3, key: 'mounting_type', label: 'Монтаж', sourceLabel: 'Монтаж',
				group: 'Исполнение', type: 'option', rawValue: 'DIN-рейка', normalizedValue: 'DIN-рейка',
				numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null,
				filterable: true, status: 'Готово для фильтра',
			}, {
				order: 4, key: 'power_supply', label: 'Питание', sourceLabel: 'Питание',
				group: 'Электрика', type: 'text', rawValue: '110–240 В AC, 50/60 Гц',
				normalizedValue: '110–240 В AC, 50/60 Гц', numberValue: null, numberMin: null,
				numberMax: null, unit: '', booleanValue: null, filterable: true,
				status: 'Готово для фильтра',
			}, {
				order: 5, key: 'connection', label: 'Подключение', sourceLabel: 'Подключение',
				group: 'Подключения', type: 'option', rawValue: 'Ethernet RJ45',
				normalizedValue: 'Ethernet RJ45', numberValue: null, numberMin: null,
				numberMax: null, unit: '', booleanValue: null, filterable: true,
				status: 'Готово для фильтра',
			});
			break;
		default:
			break;
	}

	const compatibility = {
		18346: 'Shelly 1; Shelly 1PM; все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4; Shelly 1L; Shelly Dimmer 2',
		18348: 'Shelly 1; Shelly 1PM; все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4; Shelly 1L; Shelly Dimmer 2',
		18352: 'Shelly 2.5; все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4; Shelly 1L; Shelly Dimmer 2',
		18358: 'Shelly 2.5; все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4; Shelly 1L; Shelly Dimmer 2',
		18344: 'Все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4',
		18350: 'Все Shelly Plus; Shelly 1 Gen3; Shelly 1PM Gen3; Shelly 2PM Gen3; Shelly i4 Gen3; Shelly Dimmer Gen3; Shelly DALI Dimmer Gen3; Shelly 1 Gen4; Shelly 1PM Gen4',
		18342: 'Shelly Wall Switch 1, 2 и 4',
		18354: 'Shelly Wall Switch 1, 2 и 4',
		18356: 'Shelly Wall Switch 1, 2 и 4',
		18364: 'Shelly Wall Switch 1, 2 и 4',
		18366: 'Shelly Wall Switch 1, 2 и 4',
		18368: 'Shelly Wall Switch 1, 2 и 4',
		18360: 'Shelly Frame for Wall Switch; реле в комплект не входит',
		18362: 'Shelly Frame for Wall Switch; реле в комплект не входит',
	}[product.productId];
	if (compatibility) readyOption(product, 'Совместимость', 'compatibility', compatibility);

	const wireless = product.attributes.find((attribute) => attribute.key === 'wireless');
	if (/bluetooth/iu.test(wireless?.rawValue ?? '')
		&& !product.attributes.some((attribute) => attribute.key === 'bluetooth')) {
		product.attributes.push(officialAttribute({
			key: 'bluetooth',
			label: 'Bluetooth',
			value: 'Да',
			group: 'Подключения',
			booleanValue: true,
		}));
	}

	product.attributes.forEach((attribute, index) => { attribute.order = index + 1; });
	product.filterableAttributeCount = product.attributes.filter((attribute) => attribute.filterable).length;
	product.totalAttributeCount = product.attributes.length;
	product.reviewAttributeCount = product.attributes
		.filter((attribute) => /требуется проверка/iu.test(attribute.status)).length;
	product.displayDescription = [
		product.shortDescription,
		'',
		'Характеристики:',
		...product.attributes.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`),
	].join('\n');
}

async function optimizeImage(inputPath, outputPath) {
	await new Promise((resolve, reject) => {
		const child = spawn('ffmpeg', [
			'-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath,
			'-vf', 'scale=1600:1600:force_original_aspect_ratio=decrease',
			'-c:v', 'libwebp', '-quality', '82', '-compression_level', '6',
			outputPath,
		], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
		const stderr = [];
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (code) => code === 0
			? resolve()
			: reject(new Error(Buffer.concat(stderr).toString('utf8').slice(0, 1000))));
	});
}

await fs.mkdir(outDir, { recursive: true });
const imageDir = path.join(outDir, 'images');
const originalDir = path.join(outDir, 'originals');
if (downloadImages) {
	await fs.mkdir(imageDir, { recursive: true });
	await fs.mkdir(originalDir, { recursive: true });
}

const previousDraft = resume
	? await readJson(path.join(outDir, 'catalog-draft.json')).catch(() => ({ products: [] }))
	: { products: [] };
const previousById = new Map((previousDraft.products ?? [])
	.map((product) => [Number(product.productId), product]));

const [core, catalog, schema, researchGroups] = await Promise.all([
	readJson(corePath),
	readJson(catalogPath),
	readJson(schemaPath),
	Promise.all(researchFiles.map((name) => readJson(path.join(researchDir, name)))),
]);

const coreShelly = core.rows.filter((row) =>
	cleanText(row.manufacturer).toLowerCase() === 'shelly'
	|| cleanText(row.section).toLowerCase() === 'shelly');
const coreById = new Map(coreShelly.map((row) => [Number(row.productId), row]));
const catalogById = new Map(catalog.products.map((row) => [Number(row.productId), row]));
const researchById = new Map();
for (const record of researchGroups.flat()) {
	for (const productId of record.productIds ?? []) researchById.set(Number(productId), record);
}

const products = [];
const unresolved = [];
for (const coreRow of coreShelly) {
	const productId = Number(coreRow.productId);
	if (blocked.has(productId)) {
		unresolved.push({
			productId,
			name: coreRow.name,
			reason: blocked.get(productId),
			currentImage: coreRow.image ?? '',
		});
		continue;
	}
	const product = structuredClone(catalogById.get(productId));
	if (!product) {
		unresolved.push({ productId, name: coreRow.name, reason: 'Карточка отсутствует в локальном каталоге характеристик.' });
		continue;
	}
	applyOfficialCorrections(product);
	const sourceUrl = sourceOverrides.get(productId) ?? researchById.get(productId)?.officialSourceUrl ?? product.sourceUrl ?? '';
	if (!officialShellyUrl(sourceUrl)) {
		unresolved.push({ productId, name: coreRow.name, reason: 'Нет подтверждённой страницы на официальном сайте Shelly.' });
		continue;
	}
	products.push({ product, coreRow, sourceUrl });
}

const sourceCache = new Map();
let progress = 0;
const prepared = await mapLimit(products, concurrency, async ({ product, coreRow, sourceUrl }) => {
	const previous = previousById.get(Number(product.productId));
	const forcedImageUrl = imageUrlOverrides.get(Number(product.productId)) ?? '';
	const localImageOverride = localImageOverrides.get(Number(product.productId));
	let page = null;
	let image = null;
	if (localImageOverride) {
		const overridePath = path.resolve(rootDir, localImageOverride.localPath);
		const optimized = await fs.readFile(overridePath);
		image = {
			sourceUrl: localImageOverride.sourceUrl,
			sourcePageUrl: sourceUrl,
			localPath: path.relative(rootDir, overridePath).replaceAll('\\', '/'),
			bytes: optimized.length,
			sha256: sha256(optimized),
			format: 'webp',
		};
		page = {
			pageTitle: previous?.officialPageTitle ?? '',
			sku: previous?.officialSku ?? '',
			imageCandidates: previous?.imageCandidates ?? 0,
		};
	}
	const previousImageIsGeneric = /share-general|shelly[_-]academy|solutions?-\d|shelly-1-gen4-main-image/iu
		.test(previous?.image?.sourceUrl ?? '')
		|| /Smart Home Products with Local/iu.test(previous?.officialPageTitle ?? '');
	if (!image
		&& resume
		&& previous?.officialSourceUrl === sourceUrl
		&& !previousImageIsGeneric
		&& previous?.image?.localPath) {
		const previousImagePath = path.resolve(rootDir, previous.image.localPath);
		const previousImageExists = await fs.stat(previousImagePath)
			.then((stat) => stat.isFile())
			.catch(() => false);
		if (previousImageExists) {
			image = previous.image;
			page = {
				pageTitle: previous.officialPageTitle ?? '',
				sku: previous.officialSku ?? '',
				imageCandidates: previous.imageCandidates ?? 0,
			};
		}
	}

	if (!page) {
		const sourceCacheKey = `${sourceUrl}\0${product.model}`;
		let pagePromise = sourceCache.get(sourceCacheKey);
		if (!pagePromise) {
			pagePromise = officialPageData(sourceUrl, product.model)
				.catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
				.finally(() => sleep(requestDelayMs));
			sourceCache.set(sourceCacheKey, pagePromise);
		}
		page = await pagePromise;
	}

	if (forcedImageUrl) {
		page.imageUrl = forcedImageUrl;
		if (image && normalizeImageUrl(image.sourceUrl).split('?')[0] !== normalizeImageUrl(forcedImageUrl).split('?')[0]) {
			image = null;
		}
	}

	if (!image && downloadImages && page.imageUrl) {
		try {
			const fetched = await fetchWithRetry(page.imageUrl, 'buffer');
			const extension = fetched.contentType.includes('png') ? '.png'
				: fetched.contentType.includes('webp') ? '.webp' : '.jpg';
			const originalPath = path.join(originalDir, `${product.productId}${extension}`);
			const optimizedPath = path.join(imageDir, `${product.productId}.webp`);
			await fs.writeFile(originalPath, fetched.value);
			await optimizeImage(originalPath, optimizedPath);
			const optimized = await fs.readFile(optimizedPath);
			image = {
				sourceUrl: fetched.finalUrl,
				sourcePageUrl: sourceUrl,
				localPath: path.relative(rootDir, optimizedPath).replaceAll('\\', '/'),
				bytes: optimized.length,
				sha256: sha256(optimized),
				format: 'webp',
			};
		} catch (error) {
			page.imageError = error instanceof Error ? error.message : String(error);
		}
		await sleep(Math.min(500, requestDelayMs));
	}

	const row = {
		productId: product.productId,
		currentName: coreRow.name,
		model: product.model,
		title: product.title,
		shortDescription: product.shortDescription,
		displayDescription: product.displayDescription,
		categoryKey: product.categoryKey,
		attributes: product.attributes,
		filterableAttributeCount: product.filterableAttributeCount,
		reviewAttributeCount: product.reviewAttributeCount,
		officialSourceUrl: sourceUrl,
		officialPageTitle: page.pageTitle ?? '',
		officialSku: page.sku ?? '',
		image,
		imageCandidates: page.imageCandidates ?? 0,
		error: page.error ?? page.imageError ?? '',
	};
	progress += 1;
	console.log(`progress ${progress}/${products.length} ${product.productId} ${image ? 'image' : 'no-image'}`);
	return row;
});
prepared.sort((left, right) => left.productId - right.productId);

const schemaDraft = structuredClone(schema);
for (const definition of [
	{
		key: 'neutral_required', label: 'Требуется нейтраль', type: 'option', unit: '',
		group: 'Электрика', filterable: true, aliases: ['нейтраль', 'neutral required'],
	},
	{
		key: 'ethernet_speed', label: 'Скорость Ethernet', type: 'number', unit: 'Мбит/с',
		group: 'Подключения', filterable: true, aliases: ['скорость ethernet', 'ethernet speed'],
	},
	{
		key: 'power_measurement', label: 'Измерение мощности', type: 'option', unit: '',
		group: 'Электрика', filterable: true, aliases: ['измерение мощности', 'power measurement', 'power metering'],
	},
	{
		key: 'dry_contact', label: 'Сухой контакт', type: 'option', unit: '',
		group: 'Электрика', filterable: true, aliases: ['сухой контакт', 'dry contact', 'potential-free contact'],
	},
	{
		key: 'dimming_type', label: 'Тип диммирования', type: 'option', unit: '',
		group: 'Электрика', filterable: true, aliases: ['тип диммирования', 'dimming type'],
	},
]) {
	if (!schemaDraft.attributes.some((attribute) => attribute.key === definition.key)) {
		schemaDraft.attributes.push(definition);
	}
}
schemaDraft.generatedAt = new Date().toISOString();

const totalImageBytes = prepared.reduce((sum, row) => sum + Number(row.image?.bytes ?? 0), 0);
const report = {
	generatedAt: new Date().toISOString(),
	policy: {
		characteristicSources: ['shelly.com and official regional subdomains only'],
		photoSource: 'official Shelly pages, with two explicitly approved generated photo exceptions',
		photoExceptions: [
			'18126 Shelly EM: generated module-only image from user-approved shop-shelly.ru reference',
			'18154 Shelly Wall Display White: generated clean packshot from official Shelly references',
		],
		photoFormat: 'WebP, maximum 1600x1600, quality 82',
		vpsWarningBytes: 1_500_000_000,
		vpsHardLimitBytes: 2_000_000_000,
	},
	counts: {
		coreShellyRows: coreShelly.length,
		prepared: prepared.length,
		withImage: prepared.filter((row) => row.image).length,
		withoutImage: prepared.filter((row) => !row.image).length,
		withReviewAttributes: prepared.filter((row) => row.reviewAttributeCount > 0).length,
		unresolved: unresolved.length,
	},
	totalImageBytes,
	totalImageMiB: Number((totalImageBytes / 1024 / 1024).toFixed(2)),
	unresolved,
};

const uploadPayload = {
	version: 1,
	generatedAt: report.generatedAt,
	sourcePolicy: 'official-shelly-characteristics-with-user-approved-photo-exceptions',
	rows: prepared.map((row) => ({
		productId: String(row.productId),
		description: row.displayDescription,
		category: row.categoryKey,
		attributes: row.attributes.filter((attribute) => attribute.filterable).map((attribute) => ({
			key: attribute.key,
			label: attribute.label,
			type: attribute.type,
			value: attribute.normalizedValue,
			raw: attribute.rawValue,
			number: attribute.numberValue,
			min: attribute.numberMin,
			max: attribute.numberMax,
			unit: attribute.unit,
			boolean: attribute.booleanValue,
		})),
		officialSourceUrl: row.officialSourceUrl,
		officialSku: row.officialSku,
		image: row.image,
	})),
};

await Promise.all([
	fs.writeFile(path.join(outDir, 'catalog-draft.json'), `${JSON.stringify({ generatedAt: report.generatedAt, products: prepared }, null, 2)}\n`, 'utf8'),
	fs.writeFile(path.join(outDir, 'filter-attribute-schema-draft.json'), `${JSON.stringify(schemaDraft, null, 2)}\n`, 'utf8'),
	fs.writeFile(path.join(outDir, 'upload-payload.json'), `${JSON.stringify(uploadPayload, null, 2)}\n`, 'utf8'),
	fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
]);

console.log(JSON.stringify({ outDir, ...report.counts, totalImageMiB: report.totalImageMiB }, null, 2));
