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

const inputPath = path.resolve(args.get('input') ?? 'work-catalog-video-20260728/redline-official.json');
const outputDir = path.resolve(args.get('output-dir') ?? 'work-catalog-video-20260728/redline-package');
const vendorKey = cleanArgument(args.get('vendor-key') ?? 'redline-video');
const vendorName = cleanArgument(args.get('vendor') ?? 'RedLine / PRACTICAM');
const sourceLabel = cleanArgument(args.get('source-label') ?? 'RedLine');
const imageDir = path.join(outputDir, 'images');
const outputPath = path.join(outputDir, 'catalog.json');
const source = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
function cleanArgument(value) {
	return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

const embeddedRussianLabels = [
	'Автоматический электронный затвор (AES)',
	'Широкий динамический диапазон (WDR)',
	'Фокусное расстояние / Светосила',
	'Переключение режимов День/Ночь',
	'Компенсация встречной засветки (BLC)',
	'Расширенный динамический диапазон (DWDR)',
	'Угол обзора по горизонтали',
	'Угол обзора по вертикали',
	'Угол обзора по диагонали',
	'Поддержка протокола ONVIF',
	'Поддержка карт памяти, ГБ',
	'Интерфейсы подключения',
	'Потребляемая мощность',
	'Разрешение видеозаписи',
	'Максимальное разрешение',
	'Порт для жесткого диска',
	'Разрешение матрицы',
	'Сетевое подключение',
	'Видеосенсор, модель',
	'Область интереса ROI',
	'Минимальная освещенность',
	'Поворотная камера',
	'Встроенный микрофон',
	'Место хранения записей',
	'Порты 10/100 Mbps',
	'Формат сжатия',
	'Фокусное расстояние',
	'Дальность подсветки',
	'Тип подсветки',
	'Сетевые протоколы',
	'Вес изделия',
	'Рабочая влажность',
	'Основной поток',
	'Субпоток',
	'Шумоподавление (DNR)',
	'Детектор движения',
	'Тип объектива',
	'Тип корпуса',
	'Тип камеры',
	'Тип товара',
	'Видеокодек',
	'Аудиокодек',
	'Аудиовход',
	'Аудиовыход',
	'Видеовыходы',
	'Объектив',
	'Динамик',
	'Wi-Fi',
	'Габариты',
	'Материал',
	'Битрейт',
	'PoE',
].sort((left, right) => right.length - left.length);

function normalizeEmbeddedLabel(value) {
	const label = clean(value);
	const lowerLabel = label.toLocaleLowerCase('ru');
	for (const candidate of embeddedRussianLabels) {
		const index = lowerLabel.lastIndexOf(candidate.toLocaleLowerCase('ru'));
		if (index > 0) return candidate;
	}
	return label;
}

function sanitizeSpecs(specs) {
	return specs.map((spec) => {
		const label = normalizeEmbeddedLabel(spec.label);
		const value = clean(spec.value);
		if (!label || !value) return null;
		if (/^(?:как купить|каталог(?:\s|$))/iu.test(label) || /^как купить$/iu.test(value)) return null;
		if (/^(?:standard|and video|\(mm\s*\[?inch\]?\))$/iu.test(value)) return null;
		if (/^(?:on-board storage|storage)$/iu.test(label)
			&& /(?:these technologies|temperature|defense against|cannot be used)/iu.test(value)) return null;
		if (/^(?:lens|lens type|focal length)$/iu.test(label)
			&& /detect\s+observe\s+recognize\s+identify/iu.test(value)) return null;
		if (/^(?:max\.?\s*resolution|maximum resolution|resolution)$/iu.test(label)
			&& /^(?:and lower|or lower|and higher|or higher)\b/iu.test(value)) return null;
		if (/^(?:protection|protection level)$/iu.test(label)
			&& /(?:smd|people counting|heat map|stereo analysis|face detection|perimeter)/iu.test(value)) {
			return { ...spec, label: 'Analytics', value: value.replace(/^[\s,;:.]+/u, '') };
		}
		if (/^(?:protection|protection level)$/iu.test(label)
			&& !/(?:\bip\s*\d{2}\b|\bik\s*\d{2}\b|nema|indoor|outdoor|water|dust|пыл|влаг)/iu.test(value)) return null;
		if (/^(?:audio)$/iu.test(label) && /^compression\b/iu.test(value)) {
			return { ...spec, label: 'Audio Compression', value: value.replace(/^compression\s*/iu, '') };
		}
		if (/^(?:audio)$/iu.test(label) && /^input\b/iu.test(value)) {
			return { ...spec, label: 'Audio Input', value: value.replace(/^input\s*/iu, '') };
		}
		if (/^(?:audio)$/iu.test(label) && /^output\b/iu.test(value)) {
			return { ...spec, label: 'Audio Output', value: value.replace(/^output\s*/iu, '') };
		}
		if (/^(?:power|power supply)$/iu.test(label) && /^consumption\b/iu.test(value)) {
			const consumptionValue = value.replace(/^consumption\s*/iu, '');
			return consumptionValue ? { ...spec, label: 'Power Consumption', value: consumptionValue } : null;
		}
		if (/^(?:audio)$/iu.test(label) && /^and video$/iu.test(value)) return null;
		if (/^(?:operating temperature|operating conditions|working temperature)$/iu.test(label)
			&& /^\d+(?:[.,]\d+)?\s*°?\s*C\s*(?:to|…|\.\.)\s*\+/iu.test(value)
			&& !/^0(?:[.,]0+)?\b/u.test(value)) {
			return { ...spec, label, value: `-${value}` };
		}
		if (/^\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?(?:\s*[xх×]\s*\d+(?:[.,]\d+)?)?\s*мм$/iu.test(value)
			&& !/(?:габарит|размер)/iu.test(label)) {
			return { ...spec, label: 'Габариты' };
		}
		return { ...spec, label, value };
	}).filter(Boolean);
}

function isUsableProductImage(match) {
	if (!match.image?.localPath) return false;
	const imageReference = `${match.imageUrl ?? ''} ${match.image.localPath}`;
	return !/(?:logo|logotype|header|banner|favicon|placeholder|no[-_ ]?image)/iu.test(imageReference);
}

const keyRules = [
	[/^(?:model|model no\.?|product model)$/iu, { key: 'model', group: 'Основные характеристики' }],
	[/^(?:type|camera type|product type)$/iu, { key: 'device_type', group: 'Основные характеристики', type: 'option', filterable: true }],
	[/^(?:series|product series)$/iu, { key: 'series', group: 'Основные характеристики', type: 'option', filterable: true }],
	[/^(?:max\.?\s*resolution|maximum resolution|resolution|effective pixels?)$/iu, { key: 'resolution', group: 'Видео', type: 'option', filterable: true }],
	[/^(?:image sensor|sensor)$/iu, { key: 'sensor', group: 'Видео', type: 'option', filterable: true }],
	[/^(?:min\.?\s*illumination|minimum illumination|sensitivity)$/iu, { key: 'sensitivity', group: 'Видео', filterable: true }],
	[/^(?:video compression|compression|compression standard)$/iu, { key: 'video_compression', group: 'Видео', type: 'multi_option', filterable: true }],
	[/^(?:lens|lens type|focal length|focal length & fov)$/iu, { key: 'lens', group: 'Видео', type: 'option', filterable: true }],
	[/^(?:horizontal fov|horizontal field of view|view angle)$/iu, { key: 'view_angle', group: 'Видео', type: 'number', unit: '°', filterable: true }],
	[/^(?:wide dynamic range|wdr)$/iu, { key: 'wdr', group: 'Видео', type: 'option', filterable: true }],
	[/^(?:ir distance|illumination distance|supplement light range)$/iu, { key: 'illumination_distance', group: 'Видео', type: 'number', unit: 'м', filterable: true }],
	[/^(?:supplement light type|illuminator|illumination)$/iu, { key: 'illumination', group: 'Видео', type: 'option', filterable: true }],
	[/^(?:built-in microphone|microphone)$/iu, { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }],
	[/^(?:audio|audio input|audio output|audio type)$/iu, { key: 'audio_support', group: 'Видео и аудио', type: 'option', filterable: true }],
	[/^(?:audio compression)$/iu, { key: 'audio_compression', group: 'Видео и аудио', type: 'multi_option', filterable: true }],
	[/^(?:smart event|intelligence|analytics|video analytics)$/iu, { key: 'analytics', group: 'Видеоаналитика', type: 'multi_option', filterable: true }],
	[/^(?:ethernet interface|network interface|network port)$/iu, { key: 'network_interface', group: 'Подключения', type: 'option', filterable: true }],
	[/^(?:wi-?fi|wireless)$/iu, { key: 'wifi', group: 'Подключения', type: 'option', filterable: true }],
	[/^(?:ip channels?|channel count|video input)$/iu, { key: 'channel_count', group: 'Запись', type: 'number', unit: 'канал', filterable: true }],
	[/^(?:incoming bandwidth|incoming bandwidth capacity)$/iu, { key: 'incoming_bandwidth', group: 'Запись', type: 'number', unit: 'Мбит/с', filterable: true }],
	[/^(?:outgoing bandwidth|outgoing bandwidth capacity)$/iu, { key: 'outgoing_bandwidth', group: 'Запись', type: 'number', unit: 'Мбит/с', filterable: true }],
	[/^(?:hdd|hdd interface|sata interface|hard disk interface)$/iu, { key: 'drive_bays', group: 'Хранение', type: 'number', unit: 'шт', filterable: true }],
	[/^(?:storage|on-board storage|memory card)$/iu, { key: 'storage_support', group: 'Хранение', type: 'option', filterable: true }],
	[/^(?:poe|poe port|poe ports)$/iu, { key: 'poe_ports', group: 'Подключения', type: 'number', unit: 'порт', filterable: true }],
	[/^(?:power|power supply)$/iu, { key: 'power_supply', group: 'Питание', filterable: true }],
	[/^(?:power consumption|maximum power consumption|max\.?\s*power consumption)$/iu, { key: 'power_consumption', group: 'Питание', type: 'number', unit: 'Вт', filterable: true }],
	[/^(?:operating temperature|operating conditions|working temperature)$/iu, { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', unit: '°C', filterable: true }],
	[/^(?:protection|protection level|ingress protection|ip rating)$/iu, { key: 'protection_rating', group: 'Эксплуатация', type: 'option', filterable: true }],
	[/^(?:dimensions?|product dimensions?)$/iu, { key: 'dimensions', group: 'Размеры' }],
	[/^(?:weight|net weight)$/iu, { key: 'weight', group: 'Размеры', type: 'number', unit: 'г', filterable: true }],
	[/^(?:material|casing|housing)$/iu, { key: 'material', group: 'Исполнение', type: 'option', filterable: true }],
	[/^модель$/iu, { key: 'model', group: 'Основные характеристики' }],
	[/^тип$/iu, { key: 'device_type', group: 'Основные характеристики', type: 'option', filterable: true }],
	[/^серия$/iu, { key: 'series', group: 'Основные характеристики', type: 'option', filterable: true }],
	[/разрешение.*мп|разрешение.*пиксел|разрешение$/iu, { key: 'resolution', group: 'Видео', type: 'option', filterable: true }],
	[/матриц|сенсор/iu, { key: 'sensor', group: 'Видео', type: 'option', filterable: true }],
	[/чувствительност/iu, { key: 'sensitivity', group: 'Видео', filterable: true }],
	[/кодек.*видео|сжатие.*видео/iu, { key: 'video_compression', group: 'Видео', type: 'multi_option', filterable: true }],
	[/фокусн.*расстояни|объектив/iu, { key: 'lens', group: 'Видео', type: 'option', filterable: true }],
	[/угол обзора.*горизонт/iu, { key: 'view_angle', group: 'Видео', type: 'number', unit: '°', filterable: true }],
	[/угол обзора/iu, { key: 'view_angle_text', group: 'Видео' }],
	[/динамическ.*диапазон|(?:^|\s)wdr/iu, { key: 'wdr', group: 'Видео', type: 'option', filterable: true }],
	[/дальность.*подсветк/iu, { key: 'illumination_distance', group: 'Видео', type: 'number', unit: 'м', filterable: true }],
	[/подсветк.*тип/iu, { key: 'illumination', group: 'Видео', type: 'option', filterable: true }],
	[/микрофон/iu, { key: 'audio', group: 'Видео и аудио', type: 'option', filterable: true }],
	[/аудио.*вход|аудиоканал|аудио/iu, { key: 'audio_support', group: 'Видео и аудио', type: 'option', filterable: true }],
	[/распознавание|периметр|пересечение|вторжение|детектор|аналитик/iu, { key: 'analytics', group: 'Видеоаналитика', type: 'multi_option', filterable: true }],
	[/сетевой интерфейс/iu, { key: 'network_interface', group: 'Подключения', type: 'option', filterable: true }],
	[/wi[\s‑-]*fi/iu, { key: 'wifi', group: 'Подключения', type: 'option', filterable: true }],
	[/количество.*ip.*канал|ip.*канал.*шт|канал.*ip/iu, { key: 'channel_count', group: 'Запись', type: 'number', unit: 'канал', filterable: true }],
	[/количество.*канал|видеовход.*шт/iu, { key: 'channel_count', group: 'Запись', type: 'number', unit: 'канал', filterable: true }],
	[/входящ.*пропускн|входящ.*битрейт/iu, { key: 'incoming_bandwidth', group: 'Запись', type: 'number', unit: 'Мбит/с', filterable: true }],
	[/выходящ.*пропускн|выходящ.*битрейт/iu, { key: 'outgoing_bandwidth', group: 'Запись', type: 'number', unit: 'Мбит/с', filterable: true }],
	[/количество.*(?:hdd|жестк|диск)|hdd.*шт/iu, { key: 'drive_bays', group: 'Хранение', type: 'number', unit: 'шт', filterable: true }],
	[/максимальн.*(?:hdd|диск)|объ.м.*(?:hdd|диск)/iu, { key: 'drive_capacity', group: 'Хранение', type: 'number', unit: 'ТБ', filterable: true }],
	[/micro\s*sd|карт.*памят/iu, { key: 'storage_support', group: 'Хранение', type: 'option', filterable: true }],
	[/poe.*(?:порт|канал)|количество.*poe/iu, { key: 'poe_ports', group: 'Подключения', type: 'number', unit: 'порт', filterable: true }],
	[/питание.*тип|^питание$/iu, { key: 'power_supply', group: 'Питание', filterable: true }],
	[/потребляем.*мощност/iu, { key: 'power_consumption', group: 'Питание', type: 'number', unit: 'Вт', filterable: true }],
	[/рабоч.*температур/iu, { key: 'operating_temperature', group: 'Эксплуатация', type: 'range', unit: '°C', filterable: true }],
	[/защит.*пыл|влаг|класс.*ip/iu, { key: 'protection_rating', group: 'Эксплуатация', type: 'option', filterable: true }],
	[/габарит|размер/iu, { key: 'dimensions', group: 'Размеры' }],
	[/^вес|масса/iu, { key: 'weight', group: 'Размеры', type: 'number', unit: 'г', filterable: true }],
	[/материал/iu, { key: 'material', group: 'Исполнение', type: 'option', filterable: true }],
	[/корпус.*тип|место эксплуатации/iu, { key: 'form_factor', group: 'Исполнение', type: 'option', filterable: true }],
];

function parseNumbers(value) {
	return [...clean(value).matchAll(/[−–—-]?\d+(?:[.,]\d+)?/gu)]
		.map((match) => Number(match[0].replace(/[−–—]/gu, '-').replace(',', '.')))
		.filter(Number.isFinite);
}

function firstNumberMatching(value, pattern) {
	const match = clean(value).match(pattern);
	if (!match) return null;
	const number = Number(match[1].replace(/[−–—]/gu, '-').replace(',', '.'));
	return Number.isFinite(number) ? number : null;
}

function numberForRule(key, rawValue, numbers) {
	if (key === 'illumination_distance') {
		return firstNumberMatching(rawValue, /([−–—-]?\d+(?:[.,]\d+)?)\s*(?:m|м)(?:\b|\s|\()/iu);
	}
	if (key === 'view_angle') {
		return firstNumberMatching(rawValue, /([−–—-]?\d+(?:[.,]\d+)?)\s*°/u);
	}
	if (key === 'channel_count') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:-?\s*ch\b|channels?\b|канал)/iu);
	}
	if (key === 'incoming_bandwidth' || key === 'outgoing_bandwidth') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:mbps|mbit\/s|мбит\/с)/iu);
	}
	if (key === 'drive_bays') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:×|x)?\s*(?:sata|hdd|hard\s+disks?|диск)/iu);
	}
	if (key === 'drive_capacity') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:tb|тб)/iu);
	}
	if (key === 'poe_ports') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:×|x)?\s*(?:ports?\b|poe\b|rj-?45|порт)/iu);
	}
	if (key === 'power_consumption') {
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:w\b|вт\b)/iu);
	}
	if (key === 'weight') {
		const kilograms = firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*kg\b/iu);
		if (kilograms != null) return kilograms * 1000;
		return firstNumberMatching(rawValue, /(\d+(?:[.,]\d+)?)\s*(?:g\b|гр?\b)/iu);
	}
	return numbers[0] ?? null;
}

function attributeFromSpec(spec, index, usedKeys) {
	const label = clean(spec.label);
	const rawValue = clean(spec.value);
	const rule = keyRules.find(([pattern]) => pattern.test(label))?.[1] ?? {};
	let key = rule.key ?? 'additional_characteristic';
	if (key !== 'additional_characteristic') {
		const count = (usedKeys.get(key) ?? 0) + 1;
		usedKeys.set(key, count);
		if (count > 1 && !['analytics'].includes(key)) key = `${key}_${count}`;
	}
	let type = rule.type ?? 'text';
	let normalizedValue = rawValue;
	let numberValue = null;
	let numberMin = null;
	let numberMax = null;
	let booleanValue = null;
	let unit = rule.unit ?? '';
	const numbers = parseNumbers(rawValue);
	if (type === 'number' && numbers.length) {
		const parsedNumber = numberForRule(rule.key, rawValue, numbers);
		if (parsedNumber != null) {
			numberValue = parsedNumber;
			normalizedValue = String(numberValue);
		}
	}
	if (type === 'range' && numbers.length >= 2) {
		const celsiusValues = [...rawValue.matchAll(/([−–—+-]?\d+(?:[.,]\d+)?)\s*°?\s*C\b/giu)]
			.map((match) => Number(match[1].replace(/[−–—]/gu, '-').replace(',', '.')))
			.filter(Number.isFinite);
		const rangeValues = celsiusValues.length >= 2 ? celsiusValues : numbers.slice(0, 2);
		numberMin = Math.min(rangeValues[0], rangeValues[1]);
		numberMax = Math.max(rangeValues[0], rangeValues[1]);
		normalizedValue = `${numberMin}…${numberMax}`;
	}
	if (/^(?:есть|да|поддерживается)$/iu.test(rawValue)) {
		type = 'boolean';
		booleanValue = true;
		normalizedValue = 'Да';
	}
	if (/^(?:нет|не поддерживается)$/iu.test(rawValue)) {
		type = 'boolean';
		booleanValue = false;
		normalizedValue = 'Нет';
	}
	const filterable = rule.filterable === true
		&& (type !== 'number' || numberValue != null)
		&& (type !== 'range' || numberMin != null);
	return {
		order: index + 1,
		key,
		label,
		sourceLabel: label,
		group: rule.group ?? 'Дополнительно',
		type,
		rawValue,
		normalizedValue,
		numberValue,
		numberMin,
		numberMax,
		unit,
		booleanValue,
		filterable,
		status: filterable ? 'Готово для фильтра' : 'Только для отображения',
	};
}

function runFfmpeg(inputPath, outputPath) {
	return new Promise((resolve, reject) => {
		const child = spawn('ffmpeg', [
			'-hide_banner',
			'-loglevel', 'error',
			'-y',
			'-i', inputPath,
			'-vf', 'scale=1200:1200:force_original_aspect_ratio=decrease',
			'-c:v', 'libwebp',
			'-quality', '86',
			'-compression_level', '6',
			outputPath,
		], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
		const stderr = [];
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (code) => code === 0
			? resolve()
			: reject(new Error(Buffer.concat(stderr).toString('utf8') || `ffmpeg failed (${code})`)));
	});
}

await fs.mkdir(imageDir, { recursive: true });
const confirmedMatches = source.matches.filter((match) => match.matchScore == null || match.matchScore >= 10_000);
const rejectedMatches = source.matches.filter((match) => match.matchScore != null && match.matchScore < 10_000);
const products = [];
const imageFailures = [];
for (const match of confirmedMatches) {
	const usedKeys = new Map();
	const attributes = sanitizeSpecs(match.specs).map((spec, index) => attributeFromSpec(spec, index, usedKeys));
	const model = clean(match.officialModel || match.model);
	const shortDescription = clean(match.title || match.description || `${sourceLabel} ${model}`).replace(/[.!?]+$/u, '');
	const product = {
		productId: match.id,
		currentName: match.name,
		model: match.model,
		categoryKey: match.kind === 'recorder' ? 'video_recorder' : 'camera',
		shortDescription: `${shortDescription}.`,
		displayDescription: `${shortDescription}.\n\nХарактеристики:\n${attributes
			.slice(0, 40)
			.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`)
			.join('\n')}`,
		attributes,
		sourceUrls: [match.url],
		sourceBasis: `Официальная карточка ${model} на сайте ${sourceLabel}`,
		keepExistingImage: true,
	};
	if (isUsableProductImage(match)) {
		try {
			const inputImage = path.resolve(path.dirname(inputPath), match.image.localPath);
			const outputImage = path.join(imageDir, `${match.id}.webp`);
			await runFfmpeg(inputImage, outputImage);
			const buffer = await fs.readFile(outputImage);
			product.keepExistingImage = false;
			product.image = {
				sourceUrl: match.imageUrl,
				localPath: path.relative(process.cwd(), outputImage).replaceAll('\\', '/'),
				bytes: buffer.length,
				sha256: sha256(buffer),
				format: 'webp',
				official: true,
			};
		} catch (error) {
			imageFailures.push({ id: match.id, error: String(error?.message ?? error) });
		}
	}
	products.push(product);
}

const catalog = {
	version: 1,
	vendorKey,
	vendor: vendorName,
	generatedAt: new Date().toISOString(),
	scope: {
		expectedProducts: products.length,
		targetProducts: source.scope.targets,
		matchedProducts: products.length,
		unmatchedProducts: source.scope.targets - products.length,
		imageReplacements: products.filter((product) => product.image).map((product) => product.productId),
		imagesKept: products.filter((product) => product.keepExistingImage).map((product) => product.productId),
	},
	products,
	blocked: [...source.unmatched, ...rejectedMatches].map((entry) => ({
		productId: entry.id,
		name: entry.name,
		model: entry.model,
		reason: `Точная официальная карточка модели на сайте ${sourceLabel} автоматически не подтверждена; существующие данные не подменяются.`,
		candidates: entry.candidates,
	})),
	qa: {
		productsWithoutFilterAttributes: products
			.filter((product) => !product.attributes.some((attribute) => attribute.filterable))
			.map((product) => product.productId),
		imageFailures,
		duplicateIds: products
			.filter((product, index) => products.findIndex((candidate) => candidate.productId === product.productId) !== index)
			.map((product) => product.productId),
	},
};
await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
	outputPath,
	products: products.length,
	blocked: catalog.blocked.length,
	images: catalog.scope.imageReplacements.length,
	imageFailures: imageFailures.length,
	filterableAttributes: products.reduce((sum, product) => sum + product.attributes.filter((attribute) => attribute.filterable).length, 0),
}, null, 2));
