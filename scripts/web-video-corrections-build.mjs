import fs from 'node:fs/promises';
import path from 'node:path';

const sourcePath = path.resolve('work-catalog-video-20260728/web-video-source.json');
const filteredPath = path.resolve('work-catalog-video-20260728/web-video-source-filtered.json');
const correctionsPath = path.resolve('work-catalog-video-20260728/web-video-corrections-source.json');
const source = JSON.parse(await fs.readFile(sourcePath, 'utf8'));

const correctedIds = new Set([10748, 10794, 10796, 10806]);
const sourceProducts = new Map((source.matches ?? []).map((product) => [Number(product.id), product]));

function spec(label, value) {
	return { label, value };
}

function correction(id, url, title, specs) {
	const product = sourceProducts.get(id);
	if (!product) throw new Error(`Source product ${id} is missing`);
	return {
		id,
		kind: product.kind,
		name: product.name,
		model: product.model,
		brand: product.brand,
		officialModel: product.model,
		sourceAlias: product.model,
		url,
		title,
		description: title,
		specs,
		imageUrl: '',
		matchScore: 100_000,
		sourceType: 'verified_web_correction',
		sourceLabel: new URL(url).hostname,
	};
}

const corrections = [
	correction(
		10748,
		'https://www.hikvision.com/content/dam/hikvision/products/S000000001/S000000002/S000000011/S000000022/OFR000024/M000127941/Data_Sheet/DS-2DE2C400MWG-4G_Datasheet_20240808.pdf',
		'Hikvision DS-2DE2C400MWG-4G — официальный паспорт модели',
		[
			spec('Модель', 'DS-2DE2C400MWG-4G'),
			spec('Бренд', 'Hikvision'),
			spec('Тип устройства', 'Уличная поворотная 4G IP-видеокамера'),
			spec('Матрица', '1/2.7" Progressive Scan CMOS'),
			spec('Максимальное разрешение', '2560×1440 (4 Мп)'),
			spec('Минимальная освещённость', 'Цвет: 0.005 лк при F1.6; ч/б: 0 лк с ИК'),
			spec('Объектив', 'Фиксированный, 2.8 мм или 4 мм'),
			spec('Угол обзора', '2.8 мм: 94° по горизонтали; 4 мм: 70° по горизонтали'),
			spec('Диапазон поворота', '0–345°'),
			spec('Диапазон наклона', '0–80°'),
			spec('Тип подсветки', 'ИК и белый свет'),
			spec('Дальность подсветки', 'До 30 м'),
			spec('Форматы сжатия видео', 'H.265, H.264, MJPEG'),
			spec('Мобильная связь', '4G LTE'),
			spec('ONVIF', 'Profile S, G, T'),
			spec('Сетевой интерфейс', 'RJ45 10/100 Мбит/с'),
			spec('Карта памяти', 'microSD/microSDHC/microSDXC до 512 ГБ'),
			spec('Аудио', 'Встроенные микрофон и динамик, двусторонняя связь'),
			spec('Видеоаналитика', 'Обнаружение человека и транспорта'),
			spec('Питание', '12 В DC ±25%'),
			spec('Потребляемая мощность', 'До 9 Вт'),
			spec('Рабочая температура', 'От -30 до +40 °C'),
			spec('Степень защиты', 'IP66'),
			spec('Материал корпуса', 'Пластик'),
			spec('Вес', 'Около 600 г'),
		],
	),
	correction(
		10794,
		'https://www.systemelectronics.it/shop/tiandy-ip/telecamere-tiandy-ip/telecamere-tiandy-ip-dome/tc-h334s-spec-i5w-c-wi-fi-4mm-v4-1/',
		'Tiandy TC-H334S Spec:I5W/C/WI-FI/4mm/V4.1 — точная карточка модели',
		[
			spec('Модель', 'TC-H334S Spec:I5W/C/WI-FI/4mm/V4.1'),
			spec('Бренд', 'Tiandy'),
			spec('Тип устройства', 'Уличная поворотная Wi-Fi IP-видеокамера'),
			spec('Материал корпуса', 'Металл и пластик'),
			spec('Максимальное разрешение', '2304×1296 (3 Мп) при 25 к/с'),
			spec('Форматы сжатия видео', 'S+265, H.265, H.264B, H.264M, H.264H'),
			spec('Минимальная освещённость', 'Цвет: 0.02 лк при F1.6; ч/б: 0 лк с ИК'),
			spec('Объектив', 'Фиксированный 4 мм'),
			spec('Дальность ИК-подсветки', 'До 50 м'),
			spec('Wi-Fi', 'Есть'),
			spec('Аудио', 'Встроенные микрофон и динамик'),
			spec('Карта памяти', 'microSD/microSDHC/microSDXC до 512 ГБ'),
			spec('Питание', '12 В DC ±25%'),
			spec('Потребляемая мощность', 'До 12 Вт'),
			spec('Рабочая температура', 'От -30 до +60 °C'),
			spec('Рабочая влажность', 'До 95% без конденсации'),
			spec('Степень защиты', 'IP66'),
		],
	),
	correction(
		10796,
		'https://tiandy.pl/wp-content/uploads/2024/05/1D.20010.020870_TC-C321N-I3EY2.8mmV2.0_en-1.pdf',
		'Tiandy TC-C321N Spec:I3/E/Y/2.8mm/V2.0 — паспорт модели',
		[
			spec('Модель', 'TC-C321N Spec:I3/E/Y/2.8mm/V2.0'),
			spec('Бренд', 'Tiandy'),
			spec('Тип устройства', 'Цилиндрическая IP-видеокамера'),
			spec('Матрица', '1/3" CMOS'),
			spec('Максимальное разрешение', '1920×1080 (2 Мп) при 30 к/с'),
			spec('Минимальная освещённость', 'Цвет: 0.02 лк при F2.0; ч/б: 0 лк с ИК'),
			spec('Объектив', 'Фиксированный 2.8 мм, M12, F2.0'),
			spec('Угол обзора', '94.4° по горизонтали; 53.2° по вертикали; 108.2° по диагонали'),
			spec('Дальность ИК-подсветки', 'До 30 м'),
			spec('Форматы сжатия видео', 'S+265, H.265, H.264B, H.264M, H.264H'),
			spec('Форматы сжатия аудио', 'G.711A, G.711U'),
			spec('Аудио', 'Встроенный микрофон'),
			spec('WDR', 'DWDR'),
			spec('Шумоподавление', '3D DNR'),
			spec('Питание', '12 В DC или PoE 802.3af'),
			spec('Рабочая температура', 'От -30 до +60 °C'),
			spec('Степень защиты', 'IP67'),
		],
	),
];

const filtered = {
	...source,
	generatedAt: new Date().toISOString(),
	scope: {
		...source.scope,
		matched: (source.matches ?? []).filter((product) => !correctedIds.has(Number(product.id))).length,
	},
	matches: (source.matches ?? []).filter((product) => !correctedIds.has(Number(product.id))),
	unmatched: source.unmatched ?? [],
};

const correctionSource = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourceType: 'verified_web_correction',
	sourceLabel: 'Проверенные точные паспорта моделей',
	sourceOrigins: [...new Set(corrections.map((product) => new URL(product.url).hostname))].sort(),
	scope: {
		targets: corrections.length,
		matched: corrections.length,
		unmatched: 0,
	},
	matches: corrections,
	unmatched: [],
};

await fs.writeFile(filteredPath, `${JSON.stringify(filtered, null, 2)}\n`, 'utf8');
await fs.writeFile(correctionsPath, `${JSON.stringify(correctionSource, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
	filteredPath,
	filteredMatches: filtered.matches.length,
	correctionsPath,
	corrections: corrections.length,
}, null, 2));
