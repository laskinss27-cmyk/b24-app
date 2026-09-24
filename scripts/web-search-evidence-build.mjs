import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const inputPath = path.resolve(args.get('input') ?? 'work-catalog-video-20260728/web-search-evidence.json');
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/web-search-evidence-source.json');
const source = JSON.parse(await fs.readFile(inputPath, 'utf8'));

const clean = (value) => String(value ?? '')
	.replace(/<[^>]*>/gu, ' ')
	.replace(/&nbsp;|&#160;/giu, ' ')
	.replace(/&amp;/giu, '&')
	.replace(/&quot;/giu, '"')
	.replace(/&times;/giu, '×')
	.replace(/\s+/gu, ' ')
	.trim();

const normalize = (value) => clean(value)
	.toLocaleLowerCase('ru-RU')
	.replace(/[‐‑‒–—−]/gu, '-')
	.replace(/[^a-zа-яё0-9]+/giu, '');

const baseModel = (value) => clean(value)
	.replace(/\s+(?:spec|исполнение)\s*:.+$/iu, '')
	.replace(/\s*\((?:2[.,]8|3[.,]6|4|6|8|12)\s*(?:mm|мм)\)\s*$/iu, '')
	.trim();

function addSpec(specs, label, value) {
	const normalizedLabel = clean(label).replace(/[:：]\s*$/u, '');
	const normalizedValue = clean(value);
	if (!normalizedLabel || !normalizedValue || normalizedValue.length > 600) return;
	const key = normalize(normalizedLabel);
	if (!key || specs.some((spec) => normalize(spec.label) === key)) return;
	specs.push({ label: normalizedLabel, value: normalizedValue });
}

function capture(specs, text, label, pattern, transform = (match) => match[1]) {
	const match = text.match(pattern);
	if (match) addSpec(specs, label, transform(match));
}

function extractKnownLinePairs(specs, evidence) {
	const lines = evidence
		.split(/\r?\n/u)
		.map((line) => clean(line.replace(/^[#*\-\s]+/u, '')))
		.filter(Boolean);
	const labels = [
		'Максимальное разрешение', 'Разрешение видео', 'Разрешение', 'Матрица', 'Тип матрицы',
		'Размер матрицы', 'Фокусное расстояние', 'Объектив', 'Угол обзора', 'Дальность подсветки',
		'Ночная ИК-подсветка', 'ИК-подсветка', 'Минимальная освещенность', 'Min освещенность',
		'Формат сжатия', 'Форматы сжатия видео', 'Поддержка кодеков', 'Видеосжатие',
		'Поддержка карт памяти', 'Слот для карты памяти', 'Рабочая температура',
		'Температурный режим', 'Степень защиты', 'Уровень защиты', 'Питание', 'PoE',
		'Wi-Fi', 'Микрофон', 'Запись аудио', 'Количество каналов', 'IP-каналы',
		'Видеовходы', 'Жесткий диск', 'Интерфейс HDD', 'Входящая пропускная способность',
		'Габариты камеры', 'Габариты', 'Размеры', 'Вес', 'Материал корпуса',
		'Детектор движения', 'ONVIF', 'Сетевой интерфейс',
	];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		for (const label of labels) {
			const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*[:|]?\\s*(.*)$`, 'iu').exec(line);
			if (!exact) continue;
			let value = clean(exact[1]);
			if (!value || normalize(value) === normalize(label)) value = lines[index + 1] ?? '';
			if (value && !labels.some((candidate) => normalize(candidate) === normalize(value))) addSpec(specs, label, value);
			break;
		}
	}
}

function extractSpecs(row) {
	const evidence = clean(row.evidence);
	const specs = [];
	addSpec(specs, 'Модель', row.model);
	if (row.brand) addSpec(specs, 'Бренд', row.brand);
	if (row.sourceAlias && normalize(row.sourceAlias) !== normalize(row.model)) {
		addSpec(specs, 'Модель в источнике', row.sourceAlias);
	}
	addSpec(specs, 'Тип устройства', row.kind === 'recorder' ? 'Видеорегистратор' : 'Камера видеонаблюдения');
	if (/(?:^|[-_.])KIT\d|комплект\s+видеонаблюдения/iu.test(`${row.model} ${row.name} ${evidence}`)) {
		addSpec(specs, 'Тип товара', 'Комплект видеонаблюдения');
	}
	extractKnownLinePairs(specs, String(row.evidence ?? ''));

	capture(specs, evidence, 'Разрешение матрицы', /(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(?:MP|Мп|мегапиксел)/iu, (match) => `${match[1].replace(',', '.')} Мп`);
	capture(specs, evidence, 'Максимальное разрешение', /\b(\d{3,4})\s*[xх×]\s*(\d{3,4})\b/u, (match) => `${match[1]}×${match[2]}`);
	capture(specs, evidence, 'Матрица', /\b(1\/\d(?:[.,]\d+)?\s*(?:["″'’]|inch|дюйм)?\s*(?:CMOS|КМОП))\b/iu);
	capture(specs, evidence, 'Фокусное расстояние', /(?:объектив|фокусн\w*\s+расстояни\w*|lens|focal length)[^.;]{0,50}?(\d+(?:[.,]\d+)?)\s*(?:mm|мм)\b/iu, (match) => `${match[1].replace(',', '.')} мм`);
	capture(specs, evidence, 'Дальность подсветки', /(?:ИК[-\s]*подсвет\w*|IR\s*(?:range|distance)|ночн\w*\s+съемк\w*)[^.;]{0,45}?(?:до|up to|:)?\s*(\d+(?:[.,]\d+)?)\s*(?:m|м)\b/iu, (match) => `${match[1].replace(',', '.')} м`);
	capture(specs, evidence, 'Поддержка карт памяти', /(?:micro\s*SD|кар\w*\s+памят\w*)[^.;]{0,45}?(?:до|up to)?\s*(\d+)\s*(?:GB|ГБ)\b/iu, (match) => `microSD до ${match[1]} ГБ`);
	capture(specs, evidence, 'Угол обзора', /(?:угол\s+обзора|field of view)[^.;]{0,35}?(\d+(?:[.,]\d+)?)\s*[°˚]/iu, (match) => `${match[1].replace(',', '.')}°`);
	capture(specs, evidence, 'Рабочая температура', /(?:рабоч\w*|operating)\s+(?:температур\w*|temperature)[^.;]{0,30}?([−–-]?\d+)\s*(?:°?\s*C|℃)?\s*(?:~|…|\.\.|до|to)\s*\+?(\d+)\s*(?:°?\s*C|℃)/iu, (match) => `от ${match[1]} до +${match[2]} °C`);
	capture(specs, evidence, 'Степень защиты', /\b(IP(?:6[4-9]|5[4-9]|4[4-9]))\b/iu, (match) => match[1].toUpperCase());
	capture(specs, evidence, 'Количество каналов', /(?:до|up to)?\s*(\d+)\s*(?:-?\s*channel|канал\w*)\b/iu, (match) => `${match[1]} каналов`);
	capture(specs, evidence, 'Количество HDD', /(?:до|up to)?\s*(\d+)\s*(?:x|×|шт\.?)?\s*(?:SATA|HDD)\b/iu, (match) => `${match[1]} HDD`);
	capture(specs, evidence, 'Максимальный объём HDD', /(?:SATA|HDD|жестк\w*\s+диск\w*)[^.;]{0,40}?(?:до|up to)\s*(\d+)\s*(?:TB|ТБ)\b/iu, (match) => `${match[1]} ТБ`);
	capture(specs, evidence, 'Количество камер в комплекте', /(?:из|на|состоит\s+из)\s*(\d+)(?:-х)?\s*(?:уличн\w*\s+)?камер/iu, (match) => `${match[1]} камеры`);

	const codecs = [...new Set((evidence.match(/\b(?:S\+265|H\.?26[45](?:\+)?|MJPEG)\b/giu) ?? [])
		.map((codec) => codec.toUpperCase().replace(/^H(26)/u, 'H.$1')))];
	if (codecs.length) addSpec(specs, 'Форматы сжатия видео', codecs.join(', '));
	if (/\bONVIF\b/iu.test(evidence)) addSpec(specs, 'ONVIF', 'Есть');
	if (/\bWi-?Fi\b/iu.test(evidence)) addSpec(specs, 'Wi-Fi', 'Есть');
	if (/\bPoE\b/iu.test(evidence)) addSpec(specs, 'PoE', 'Есть');
	if (/(?:встроенн\w*\s+микрофон|built-in mic|двусторонн\w*\s+аудио)/iu.test(evidence)) addSpec(specs, 'Аудио', 'Есть');
	if (/(?:детектор\w*\s+движени|motion detection)/iu.test(evidence)) addSpec(specs, 'Детектор движения', 'Есть');
	return specs;
}

const matches = [];
const unmatched = [];
for (const row of source.rows ?? []) {
	if (!row.url) {
		unmatched.push({ ...row, reason: 'Точная открытая страница модели не найдена.' });
		continue;
	}
	const normalizedModel = normalize(baseModel(row.sourceAlias || row.model || row.name));
	const evidenceHaystack = normalize(`${row.evidence} ${row.url}`);
	if (normalizedModel.length < 4 || !evidenceHaystack.includes(normalizedModel)) {
		unmatched.push({ ...row, reason: 'Найденная страница не подтверждает точную модель.' });
		continue;
	}
	const deviceContext = row.kind === 'recorder'
		? /(?:видеорегистратор|регистратор|network video recorder|\bNVR\b|\bDVR\b|\bXVR\b)/iu
		: /(?:видеокамер|камера видеонаблюдения|IP[-\s]*камер|network camera|security camera|\bCCTV\b)/iu;
	if (!deviceContext.test(`${row.evidence} ${row.name}`)) {
		unmatched.push({ ...row, reason: 'Совпадение артикула найдено вне контекста видеонаблюдения.' });
		continue;
	}
	const specs = extractSpecs(row);
	if (specs.length < 5) {
		unmatched.push({ ...row, reason: `В поисковом источнике найдено только ${specs.length} пригодных характеристик.` });
		continue;
	}
	const title = clean(String(row.evidence ?? '').split(/\r?\n/u)[0]).replace(/\s*\(https?:\/\/.+$/u, '');
	matches.push({
		id: Number(row.id),
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		officialModel: row.model,
		sourceAlias: row.sourceAlias || '',
		url: row.url,
		title: title || `${row.brand} ${row.model}`,
		description: clean(row.evidence).slice(0, 900),
		specs,
		imageUrl: '',
		matchScore: 100_000,
		sourceType: 'web_search_evidence',
		sourceLabel: new URL(row.url).hostname,
	});
}

matches.sort((left, right) => left.id - right.id);
unmatched.sort((left, right) => left.id - right.id);
const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourceType: 'web_search_evidence',
	sourceLabel: 'Открытые интернет-источники',
	sourceOrigins: [...new Set(matches.map((match) => new URL(match.url).hostname.toLowerCase()))].sort(),
	scope: {
		targets: (source.rows ?? []).length,
		matched: matches.length,
		unmatched: unmatched.length,
	},
	matches,
	unmatched,
};
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, scope: result.scope, sourceOrigins: result.sourceOrigins }, null, 2));
