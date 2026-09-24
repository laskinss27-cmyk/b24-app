import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const rootDir = process.cwd();
const outDir = path.resolve('local-artifacts/shelly-new-cards-20260728');
const imageDir = path.join(outDir, 'images');
const originalDir = path.join(outDir, 'originals');

const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function attr(label, rawValue, {
	key = 'additional_characteristic',
	group = 'Дополнительно',
	type = 'text',
	normalizedValue = rawValue,
	numberValue = null,
	numberMin = null,
	numberMax = null,
	unit = '',
	booleanValue = null,
	filterable = false,
} = {}) {
	return {
		key,
		label,
		sourceLabel: label,
		group,
		type,
		rawValue,
		normalizedValue: String(normalizedValue),
		numberValue,
		numberMin,
		numberMax,
		unit,
		booleanValue,
		filterable,
		status: filterable ? 'Готово для фильтра' : 'Только для отображения',
	};
}

const definitions = [
	{
		productId: 20518,
		currentName: 'Датчик температуры и влажности с дисплеем Shelly BLU H&T Display ZB White',
		model: 'Shelly BLU H&T Display ZB White',
		sourceUrl: 'https://www.shelly.com/products/shelly-blu-h-t-display-zb?variant=58801481777501',
		summary: 'Беспроводной датчик с энергоэффективным e-paper-дисплеем, который показывает температуру, влажность, освещённость и время. Работает по Zigbee 3.0 и Bluetooth 5.0, может устанавливаться на столе, полке или стене.',
		attributes: [
			attr('Модель устройства', 'SBHT-103C'),
			attr('Измеряемые параметры', 'температура, влажность, освещённость', { key: 'measured_values', group: 'Датчики', type: 'multi_option', filterable: true }),
			attr('Дисплей', 'графический e-paper с часами', { key: 'display', group: 'Интерфейс', type: 'option', filterable: true }),
			attr('Беспроводная связь', 'Zigbee 3.0; Bluetooth 5.0 LE', { key: 'wireless', group: 'Подключения', type: 'multi_option', filterable: true }),
			attr('Питание', '2 батареи CR2032', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Срок работы батарей', 'до 2 лет'),
			attr('Монтаж', 'стена, стол или полка', { key: 'mounting_type', group: 'Монтаж', type: 'multi_option', filterable: true }),
			attr('Габариты', '65 × 65 × 9 мм; с настольной подставкой 65 × 65 × 33 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '38 г с батареями; 43 г с подставкой', { key: 'weight', group: 'Размеры' }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−10…+40 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-10…40', numberMin: -10, numberMax: 40, unit: '°C', filterable: true }),
		],
	},
	{
		productId: 20522,
		currentName: 'Розеточный энергомонитор Shelly Plug PM Gen3 White',
		model: 'Shelly Plug PM Gen3 White',
		sourceUrl: 'https://www.shelly.com/products/shelly-plug-pm-gen3-white',
		summary: 'Розеточный энергомонитор для непрерывного контроля напряжения, тока, мощности и потребления подключённого прибора. Рассчитан на нагрузку до 16 А и 3680 Вт. Важно: встроенного реле нет — устройство измеряет параметры, но не включает и не отключает нагрузку.',
		attributes: [
			attr('Модель устройства', 'S3PL-30116EU'),
			attr('Тип устройства', 'розеточный энергомонитор без реле', { key: 'product_type', group: 'Идентификация', type: 'option', filterable: true }),
			attr('Измеряемые параметры', 'напряжение, ток, мощность и энергия', { key: 'measured_values', group: 'Измерения', type: 'multi_option', filterable: true }),
			attr('Максимальный ток', '16 А', { key: 'max_current', group: 'Электрика', type: 'number', normalizedValue: '16', numberValue: 16, unit: 'А', filterable: true }),
			attr('Максимальная мощность', '3680 Вт', { key: 'power', group: 'Электрика', type: 'number', normalizedValue: '3680', numberValue: 3680, unit: 'Вт', filterable: true }),
			attr('Питание', '230 В AC, 50 Гц', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Розетка и вилка', 'Type E/F (Schuko)', { key: 'socket_type', group: 'Подключения', type: 'option', filterable: true }),
			attr('Беспроводная связь', 'Wi‑Fi 802.11 b/g/n; Bluetooth 4.2', { key: 'wireless', group: 'Подключения', type: 'multi_option', filterable: true }),
			attr('Реле', 'Нет', { key: 'relay', group: 'Функции', type: 'boolean', normalizedValue: 'Нет', booleanValue: false, filterable: true }),
			attr('Габариты', '44 × 44 × 70 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '48 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '48', numberValue: 48, unit: 'г', filterable: true }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−20…+40 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-20…40', numberMin: -20, numberMax: 40, unit: '°C', filterable: true }),
		],
	},
	{
		productId: 20526,
		currentName: 'Умный сетевой фильтр Shelly Power Strip 4 Gen4 White',
		model: 'Shelly Power Strip 4 Gen4 White',
		sourceUrl: 'https://www.shelly.com/products/shelly-power-strip-4-gen4?variant=58281504211293',
		summary: 'Умный сетевой фильтр с четырьмя независимо управляемыми розетками Schuko. Для каждой розетки доступен отдельный учёт потребления и световая индикация. Поддерживает Wi‑Fi, Bluetooth, Zigbee и Matter, локальные сценарии и защиту от перегрева, перенапряжения, перегрузки по току и мощности.',
		attributes: [
			attr('Модель устройства', 'S4PL-00416EU'),
			attr('Количество розеток', '4', { key: 'channels_count', group: 'Электрика', type: 'number', normalizedValue: '4', numberValue: 4, filterable: true }),
			attr('Тип розеток', 'CEE 7/3 Type F (Schuko)', { key: 'socket_type', group: 'Подключения', type: 'option', filterable: true }),
			attr('Максимальный ток', '12 А на розетку; 16 А суммарно', { key: 'max_current', group: 'Электрика', type: 'text', filterable: true }),
			attr('Максимальная мощность', '3680 Вт суммарно', { key: 'power', group: 'Электрика', type: 'number', normalizedValue: '3680', numberValue: 3680, unit: 'Вт', filterable: true }),
			attr('Питание', '220–240 В AC, 50/60 Гц', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Измерение энергии', 'отдельно для каждой розетки', { key: 'power_metering', group: 'Измерения', type: 'option', filterable: true }),
			attr('Беспроводная связь', 'Wi‑Fi; Bluetooth; Zigbee; Matter', { key: 'wireless', group: 'Подключения', type: 'multi_option', filterable: true }),
			attr('Защита', 'перегрев, перенапряжение, сверхток и превышение мощности', { key: 'protection', group: 'Безопасность', type: 'multi_option', filterable: true }),
			attr('Длина кабеля', '1,5 м', { key: 'cable_length', group: 'Размеры', type: 'number', normalizedValue: '1.5', numberValue: 1.5, unit: 'м', filterable: true }),
			attr('Габариты', '43 × 237 × 56 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '560 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '560', numberValue: 560, unit: 'г', filterable: true }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−20…+40 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-20…40', numberMin: -20, numberMax: 40, unit: '°C', filterable: true }),
		],
	},
	{
		productId: 20530,
		currentName: 'Датчик температуры и влажности Shelly BLU H&T ZB Mocha',
		model: 'Shelly BLU H&T ZB Mocha',
		sourceUrl: 'https://www.shelly.com/products/shelly-blu-h-t-zb-mocha',
		summary: 'Компактный датчик температуры и влажности в корпусе цвета мокко. Работает по Zigbee 3.0 и Bluetooth 5.0, защищён от пыли и брызг по IP54 и подходит для помещений и защищённых уличных зон.',
		attributes: [
			attr('Модель устройства', 'SBHT-203C'),
			attr('Измеряемые параметры', 'температура и влажность', { key: 'measured_values', group: 'Датчики', type: 'multi_option', filterable: true }),
			attr('Беспроводная связь', 'Zigbee 3.0; Bluetooth 5.0 LE', { key: 'wireless', group: 'Подключения', type: 'multi_option', filterable: true }),
			attr('Степень защиты', 'IP54', { key: 'protection_rating', group: 'Защита', type: 'option', filterable: true }),
			attr('Питание', '1 батарея CR2032, 3 В', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Срок работы батареи', 'до 3 лет'),
			attr('Диапазон влажности', '0…100 % RH', { key: 'humidity_range', group: 'Измерения', type: 'range', normalizedValue: '0…100', numberMin: 0, numberMax: 100, unit: '% RH', filterable: true }),
			attr('Габариты', '37 × 37 × 10 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '13 г', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '13', numberValue: 13, unit: 'г', filterable: true }),
			attr('Цвет', 'мокко', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−20…+60 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-20…60', numberMin: -20, numberMax: 60, unit: '°C', filterable: true }),
		],
	},
	...[
		{ productId: 20534, color: 'белый', slug: 'shelly-presence-gen4-white' },
		{ productId: 20538, color: 'чёрный', slug: 'shelly-presence-gen4-black?variant=58439205421405' },
	].map(({ productId, color, slug }) => ({
		productId,
		currentName: `Датчик присутствия Shelly Presence Gen4 ${color === 'белый' ? 'White' : 'Black'}`,
		model: `Shelly Presence Gen4 ${color === 'белый' ? 'White' : 'Black'}`,
		sourceUrl: `https://www.shelly.com/products/${slug}`,
		summary: 'Радарный датчик настоящего присутствия: обнаруживает людей даже без движения, отслеживает до шести человек и поддерживает до десяти настраиваемых зон. Работает без камеры, имеет датчик освещённости и поддерживает Wi‑Fi 6, Bluetooth 5 LE, Zigbee 3.0 и Matter-over-Wi‑Fi.',
		attributes: [
			attr('Модель устройства', 'S4SN-0U61X'),
			attr('Тип датчика', 'mmWave-радар присутствия', { key: 'sensor_type', group: 'Датчики', type: 'option', filterable: true }),
			attr('Количество отслеживаемых людей', 'до 6', { key: 'tracked_people', group: 'Датчики', type: 'number', normalizedValue: '6', numberValue: 6, filterable: true }),
			attr('Количество зон', 'до 10', { key: 'zones_count', group: 'Датчики', type: 'number', normalizedValue: '10', numberValue: 10, filterable: true }),
			attr('Площадь обнаружения', 'до 42 м²', { key: 'coverage_area', group: 'Датчики', type: 'number', normalizedValue: '42', numberValue: 42, unit: 'м²', filterable: true }),
			attr('Обнаружение неподвижного присутствия', 'до 3 м', { key: 'still_detection_range', group: 'Датчики', type: 'number', normalizedValue: '3', numberValue: 3, unit: 'м', filterable: true }),
			attr('Дополнительный датчик', 'освещённость', { key: 'additional_sensor', group: 'Датчики', type: 'option', filterable: true }),
			attr('Беспроводная связь', 'Wi‑Fi 6; Bluetooth 5 LE; Zigbee 3.0; Matter-over-Wi‑Fi', { key: 'wireless', group: 'Подключения', type: 'multi_option', filterable: true }),
			attr('Питание', 'USB‑C, 5 В DC, 1 А', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Монтаж', 'подставка, клейкая лента или крепление винтами', { key: 'mounting_type', group: 'Монтаж', type: 'multi_option', filterable: true }),
			attr('Габариты', '64 × 41 × 26 мм без подставки; 73 × 41 × 37 мм с подставкой', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '42 г без подставки; 85 г с подставкой', { key: 'weight', group: 'Размеры' }),
			attr('Цвет', color, { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−20…+40 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-20…40', numberMin: -20, numberMax: 40, unit: '°C', filterable: true }),
		],
	})),
	{
		productId: 20542,
		currentName: 'Датчик температуры и влажности Shelly H&T White',
		model: 'Shelly H&T White',
		sourceUrl: 'https://www.shelly.com/products/shelly-h-t-white',
		summary: 'Беспроводной Wi‑Fi-датчик температуры и влажности первого поколения в белом корпусе. Работает автономно от батареи CR123A, поддерживает MQTT и локальный веб-интерфейс. Модель снята с производства.',
		attributes: [
			attr('Модель', 'Shelly H&T Gen1'),
			attr('Статус модели', 'снята с производства'),
			attr('Измеряемые параметры', 'температура и влажность', { key: 'measured_values', group: 'Датчики', type: 'multi_option', filterable: true }),
			attr('Беспроводная связь', 'Wi‑Fi 802.11 b/g/n', { key: 'wireless', group: 'Подключения', type: 'option', filterable: true }),
			attr('Питание', '1 батарея CR123A, 3 В', { key: 'power_supply', group: 'Электрика', type: 'text', filterable: true }),
			attr('Срок работы батареи', 'до 18 месяцев'),
			attr('Диапазон влажности', '20…90 % RH', { key: 'humidity_range', group: 'Измерения', type: 'range', normalizedValue: '20…90', numberMin: 20, numberMax: 90, unit: '% RH', filterable: true }),
			attr('MQTT', 'Да', { key: 'mqtt', group: 'Интеграции', type: 'boolean', normalizedValue: 'Да', booleanValue: true, filterable: true }),
			attr('Габариты', '35 × 46 мм', { key: 'dimensions', group: 'Размеры' }),
			attr('Масса', '33 г с батареей', { key: 'weight', group: 'Размеры', type: 'number', normalizedValue: '33', numberValue: 33, unit: 'г', filterable: true }),
			attr('Цвет', 'белый', { key: 'color', group: 'Внешний вид', type: 'option', filterable: true }),
			attr('Рабочая температура', '−10…+50 °C', { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', normalizedValue: '-10…50', numberMin: -10, numberMax: 50, unit: '°C', filterable: true }),
		],
	},
];

async function fetchWithRetry(url, responseType = 'text') {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				redirect: 'follow',
				headers: {
					'user-agent': 'b24-app-shelly-new-cards/1.0',
					accept: responseType === 'buffer'
						? 'image/avif,image/webp,image/png,image/jpeg,*/*'
						: 'application/json,text/html;q=0.9,*/*;q=0.8',
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return responseType === 'buffer'
				? { value: Buffer.from(await response.arrayBuffer()), finalUrl: response.url, contentType: response.headers.get('content-type') ?? '' }
				: { value: await response.text(), finalUrl: response.url, contentType: response.headers.get('content-type') ?? '' };
		} catch (error) {
			lastError = error;
			await sleep(attempt * 800);
		}
	}
	throw lastError;
}

function colorTokens(model) {
	if (/white/iu.test(model)) return ['white'];
	if (/black/iu.test(model)) return ['black'];
	if (/mocha/iu.test(model)) return ['mocha'];
	return [];
}

function imageScore(url, model) {
	const value = decodeURIComponent(String(url)).toLowerCase();
	let score = 0;
	if (/main[-_ ]?image|front[-_ ]?view|product[-_ ]?image/u.test(value)) score += 30;
	if (/lifestyle|diagram|wiring|packaging|dimensions|solution|install/u.test(value)) score -= 40;
	const colors = colorTokens(model);
	if (colors.length) score += colors.some((token) => value.includes(token)) ? 60 : -10;
	for (const token of model.toLowerCase().replace('shelly', '').split(/[^\p{L}\p{N}]+/gu).filter((part) => part.length > 2)) {
		if (value.includes(token)) score += 3;
	}
	return score;
}

const imageUrlOverrides = new Map([
	[20518, 'https://cdn.shopify.com/s/files/1/0871/9967/8813/files/Shelly_BLU_H_T_ZB_White_EU_main.png?v=1776771819'],
	[20522, 'https://cdn.shopify.com/s/files/1/0871/9967/8813/files/Shelly-Plug-PM-Gen3-White-main-image-01.png?v=1762776664'],
	[20526, 'https://cdn.shopify.com/s/files/1/0871/9967/8813/files/Shelly-Power-Strip4-Gen4-White-main-image-01.png?v=1757932096'],
	[20530, 'https://cdn.shopify.com/s/files/1/0871/9967/8813/files/Shelly-BLU-H-and-T-Mocha-main-image.png?v=1739798205'],
	[20534, 'https://cdn.shopify.com/s/files/1/0871/9967/8813/files/Shelly-Presence-Gen4_Plug_Play_White_main_image_01.png?v=1775217127'],
]);

async function productImage(definition) {
	const source = new URL(definition.sourceUrl);
	if (!/(^|\.)shelly\.com$/iu.test(source.hostname)) throw new Error(`Not an official Shelly URL: ${source}`);
	const imageOverride = imageUrlOverrides.get(definition.productId);
	if (imageOverride) return { imageUrl: imageOverride, sku: '', title: definition.model };
	const variantId = source.searchParams.get('variant');
	const productUrl = new URL(source);
	productUrl.search = '';
	productUrl.pathname = `${productUrl.pathname.replace(/\/$/u, '')}.js`;
	const product = JSON.parse((await fetchWithRetry(productUrl.toString())).value);
	const exactVariant = variantId
		? (product.variants ?? []).find((variant) => String(variant.id) === variantId)
		: null;
	const scoredVariant = (product.variants ?? [])
		.filter((variant) => variant.featured_image?.src)
		.map((variant) => ({
			variant,
			score: imageScore(`${variant.title} ${variant.featured_image.src}`, definition.model),
		}))
		.sort((left, right) => right.score - left.score)[0]?.variant;
	const candidates = [
		exactVariant?.featured_image?.src,
		scoredVariant?.featured_image?.src,
		...(product.images ?? []),
		product.featured_image,
	].filter(Boolean);
	const imageUrl = [...new Set(candidates)]
		.map((url, index) => ({ url: String(url).startsWith('//') ? `https:${url}` : String(url), score: imageScore(url, definition.model) - index / 1000 }))
		.sort((left, right) => right.score - left.score)[0]?.url;
	if (!imageUrl) throw new Error(`No official image for ${definition.productId}`);
	return { imageUrl, sku: clean((exactVariant ?? scoredVariant)?.sku), title: clean(product.title) };
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

await fs.mkdir(imageDir, { recursive: true });
await fs.mkdir(originalDir, { recursive: true });
const products = [];
for (const definition of definitions) {
	const page = await productImage(definition);
	const fetched = await fetchWithRetry(page.imageUrl, 'buffer');
	const extension = fetched.contentType.includes('png') ? '.png'
		: fetched.contentType.includes('webp') ? '.webp' : '.jpg';
	const originalPath = path.join(originalDir, `${definition.productId}${extension}`);
	const imagePath = path.join(imageDir, `${definition.productId}.webp`);
	await fs.writeFile(originalPath, fetched.value);
	await optimizeImage(originalPath, imagePath);
	const image = await fs.readFile(imagePath);
	const attributes = definition.attributes.map((attribute, index) => ({ order: index + 1, ...attribute }));
	const displayDescription = [
		definition.summary,
		`Характеристики:\n${attributes.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`).join('\n')}`,
	].join('\n\n');
	products.push({
		productId: definition.productId,
		currentName: definition.currentName,
		model: definition.model,
		title: definition.currentName,
		shortDescription: definition.summary,
		displayDescription,
		categoryKey: 'smart_home',
		attributes,
		filterableAttributeCount: attributes.filter((attribute) => attribute.filterable).length,
		reviewAttributeCount: 0,
		officialSourceUrl: definition.sourceUrl,
		officialPageTitle: page.title,
		officialSku: page.sku,
		image: {
			sourceUrl: fetched.finalUrl,
			sourcePageUrl: definition.sourceUrl,
			localPath: path.relative(rootDir, imagePath).replaceAll('\\', '/'),
			bytes: image.length,
			sha256: sha256(image),
			format: 'webp',
		},
	});
	console.log(`${definition.productId} ${attributes.length} attrs ${image.length} bytes ${fetched.finalUrl}`);
	await sleep(300);
}

products.sort((left, right) => left.productId - right.productId);
const report = {
	generatedAt: new Date().toISOString(),
	sourcePolicy: 'official-shelly-only',
	prepared: products.length,
	withImage: products.filter((product) => product.image).length,
	totalAttributes: products.reduce((sum, product) => sum + product.attributes.length, 0),
	filterableAttributes: products.reduce((sum, product) => sum + product.filterableAttributeCount, 0),
	totalImageBytes: products.reduce((sum, product) => sum + product.image.bytes, 0),
	ids: products.map((product) => product.productId),
};
await fs.writeFile(path.join(outDir, 'catalog-draft.json'), `${JSON.stringify({ generatedAt: report.generatedAt, products }, null, 2)}\n`, 'utf8');
await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
