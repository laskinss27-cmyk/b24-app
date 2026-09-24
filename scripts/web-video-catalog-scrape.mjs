import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const inputPath = path.resolve(args.get('input') ?? 'work-catalog-video-20260728/unmatched-current-stock.json');
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/web-video-source.json');
const concurrency = Math.max(1, Math.min(4, Number(args.get('concurrency') ?? 3)));
const refresh = /^(?:1|true|yes)$/iu.test(args.get('refresh') ?? '');
const source = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const requestedIds = new Set(String(args.get('ids') ?? '')
	.split(',')
	.map((value) => value.trim())
	.filter(Boolean)
	.map((value) => Number(value))
	.filter(Number.isFinite));
const allTargets = Array.isArray(source.blocked) ? source.blocked : [];
const targets = requestedIds.size
	? allTargets.filter((row) => requestedIds.has(Number(row.productId)))
	: allTargets;

const clean = (value) => String(value ?? '')
	.replace(/<br\s*\/?>/giu, '\n')
	.replace(/<[^>]*>/gu, ' ')
	.replace(/&nbsp;|&#160;/giu, ' ')
	.replace(/&quot;|&#34;/giu, '"')
	.replace(/&apos;|&#39;/giu, "'")
	.replace(/&amp;/giu, '&')
	.replace(/&laquo;/giu, '«')
	.replace(/&raquo;/giu, '»')
	.replace(/&deg;/giu, '°')
	.replace(/&mdash;|&ndash;|&#8211;|&#8212;/giu, '-')
	.replace(/&#(\d+);/gu, (_, number) => String.fromCodePoint(Number(number)))
	.replace(/&#x([\da-f]+);/giu, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
	.replace(/\s+/gu, ' ')
	.trim();

const normalize = (value) => clean(value)
	.toLocaleLowerCase('ru-RU')
	.replace(/[‐‑‒–—−]/gu, '-')
	.replace(/[^a-zа-яё0-9]+/giu, '');

const canonicalModel = (value) => clean(value)
	.replace(/\s+(?:spec|исполнение)\s*:.+$/iu, '')
	.replace(/\s*\((?:2[.,]8|3[.,]6|4|6|8|12)\s*(?:mm|мм)\)\s*$/iu, '')
	.trim();

function decodeHtmlBuffer(buffer) {
	const head = buffer.subarray(0, 12_000).toString('latin1');
	const declared = head.match(/charset\s*=\s*["']?\s*([\w-]+)/iu)?.[1]?.toLowerCase();
	if (declared && /(?:windows-1251|cp1251)/u.test(declared)) return new TextDecoder('windows-1251').decode(buffer);
	return buffer.toString('utf8');
}

async function curlBuffer(url, maxBytes = 30 * 1024 * 1024) {
	const { stdout } = await execFileAsync('curl.exe', [
		'-sS',
		'-L',
		'--compressed',
		'--max-time', '22',
		'--connect-timeout', '8',
		'-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
		'-H', 'Accept-Language: ru,en;q=0.8',
		url,
	], {
		encoding: 'buffer',
		maxBuffer: maxBytes,
		timeout: 40_000,
		windowsHide: true,
	});
	return Buffer.from(stdout);
}

function decodeDuckDuckGoUrl(rawHref) {
	try {
		const href = clean(rawHref).replaceAll('&amp;', '&');
		const redirect = new URL(href, 'https://duckduckgo.com');
		const target = redirect.searchParams.get('uddg');
		return target ? decodeURIComponent(target) : redirect.toString();
	} catch {
		return '';
	}
}

function parseSearchResults(html) {
	const results = [];
	for (const block of html.matchAll(/<div[^>]+class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div[^>]+class=["'][^"']*\bresult\b|$)/giu)) {
		const anchor = block[1].match(/<a[^>]+class=["'][^"']*\bresult__a\b[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/iu);
		if (!anchor) continue;
		const url = decodeDuckDuckGoUrl(anchor[1]);
		if (!/^https?:\/\//iu.test(url)) continue;
		results.push({
			url,
			title: clean(anchor[2]),
			snippet: clean(block[1].match(/class=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/iu)?.[1]),
		});
	}
	return [...new Map(results.map((result) => [result.url, result])).values()];
}

function decodeJavaScriptString(value) {
	try {
		return JSON.parse(`"${value.replaceAll('"', '\\"').replaceAll('\\\\"', '\\"')}"`);
	} catch {
		return value
			.replace(/\\u([\da-f]{4})/giu, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
			.replaceAll('\\/', '/')
			.replaceAll('\\"', '"')
			.replaceAll('\\\\', '\\');
	}
}

function parseBraveSearchResults(html) {
	const results = [];
	for (const match of html.matchAll(/\{title:"((?:\\.|[^"])*)",url:"((?:\\.|[^"])*)",full_title:(?:void 0|"((?:\\.|[^"])*)"),description:"((?:\\.|[^"])*)"/gu)) {
		const title = clean(decodeJavaScriptString(match[1]));
		const url = decodeJavaScriptString(match[2]);
		const snippet = clean(decodeJavaScriptString(match[4]));
		if (/^https?:\/\//iu.test(url)) results.push({ url, title, snippet });
	}
	if (results.length) return [...new Map(results.map((result) => [result.url, result])).values()];
	for (const match of html.matchAll(/<div[^>]+data-type=["']web["'][\s\S]*?<a[^>]+href=["'](https?:\/\/[^"']+)["'][\s\S]*?<div[^>]+class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu)) {
		results.push({ url: clean(match[1]), title: clean(match[2]), snippet: '' });
	}
	return [...new Map(results.map((result) => [result.url, result])).values()];
}

const blockedHosts = [
	'youtube.com', 'www.youtube.com', 'rutube.ru', 'vk.com', 'facebook.com',
	'instagram.com', 'pinterest.com', 'avito.ru', 'ozon.ru', 'wildberries.ru',
	'aliexpress.ru', 'market.yandex.ru', 'price.ru', 'e-katalog.ru',
];

const preferredHosts = [
	'assets.hikvision.com', 'www.hikvision.com', 'www.dahuasecurity.com',
	'material.dahuasecurity.com', 'materialfile.dahuasecurity.com',
	'en.tiandy.com', 'www.tiandy.com', 'www.dssl.ru', 'trassir.com',
	'hiwatch.ru', 'hi.watch', 'redline-cctv.ru', 'fox-cctv.ru',
	'optimus-cctv.ru', 'vstarcam.ru', 'vstarcam.com', 'videoglaz.ru',
	'www.videoglaz.ru', 'manuals.plus', 'www.kns.ru', 'www.technocity.ru',
	'www.regard.ru', 'www.telecamera.ru', 'tiandy-russia.ru',
	'www.sourceipcameras.com', 'ipdrom.ru', 'www.ipdrom.ru',
];

function modelMatchScore(row, result) {
	const model = canonicalModel(row.model || row.name);
	const normalizedModel = normalize(model);
	const haystack = normalize(`${result.title} ${result.snippet} ${result.url}`);
	if (normalizedModel.length < 4 || !haystack.includes(normalizedModel)) return 0;
	let score = 100_000 + normalizedModel.length;
	const specificTokens = clean(row.model)
		.split(/[^a-zа-яё0-9.]+/giu)
		.map(normalize)
		.filter((token) => token.length >= 2 && !normalizedModel.includes(token));
	for (const token of specificTokens) {
		if (haystack.includes(token)) score += 750;
	}
	let hostname = '';
	try {
		hostname = new URL(result.url).hostname.toLowerCase();
	} catch {
		return 0;
	}
	if (blockedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) return 0;
	const preferredIndex = preferredHosts.indexOf(hostname);
	if (preferredIndex >= 0) score += 20_000 - preferredIndex * 100;
	if (/\.pdf(?:$|[?#])/iu.test(result.url)) score -= 8_000;
	if (/manual|datasheet|data[-_ ]?sheet|specification|техническ|характерист/iu.test(`${result.title} ${result.snippet} ${result.url}`)) score += 2_000;
	if (/\/(?:catalog|category|search|poisk|tag|actions?|brands?|news)(?:\/|[?#])/iu.test(result.url)) score -= 6_000;
	if (/\/(?:product|products|item|goods|technical-details)(?:\/|[?#])/iu.test(result.url)) score += 1_500;
	return score;
}

async function search(row) {
	const model = canonicalModel(row.model || row.name);
	const queries = [
		`"${clean(row.model || row.name)}" характеристики`,
		`"${model}" характеристики`,
		`"${model}" specifications`,
	];
	const combined = [];
	for (const query of queries) {
		try {
			const braveUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`;
			const braveHtml = decodeHtmlBuffer(await curlBuffer(braveUrl, 18 * 1024 * 1024));
			combined.push(...parseBraveSearchResults(braveHtml));
		} catch {
			// A second search engine remains available below.
		}
		let ranked = [...new Map(combined.map((entry) => [entry.url, entry])).values()]
			.map((entry) => ({ ...entry, score: modelMatchScore(row, entry) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score);
		if (ranked.some((entry) => !/\.pdf(?:$|[?#])/iu.test(entry.url))) return ranked;
		try {
			const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
			const html = decodeHtmlBuffer(await curlBuffer(searchUrl, 8 * 1024 * 1024));
			combined.push(...parseSearchResults(html));
		} catch {
			// Keep the candidates already returned by Brave Search.
		}
		ranked = [...new Map(combined.map((entry) => [entry.url, entry])).values()]
			.map((entry) => ({ ...entry, score: modelMatchScore(row, entry) }))
			.filter((entry) => entry.score > 0)
			.sort((left, right) => right.score - left.score);
		if (ranked.some((entry) => !/\.pdf(?:$|[?#])/iu.test(entry.url))) return ranked;
	}
	return [...new Map(combined.map((entry) => [entry.url, entry])).values()]
		.map((entry) => ({ ...entry, score: modelMatchScore(row, entry) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);
}

function metaValue(html, key) {
	for (const tag of html.matchAll(/<meta[^>]+>/giu)) {
		const attributes = Object.fromEntries([...tag[0].matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
			.map((match) => [match[1].toLowerCase(), match[2]]));
		if (String(attributes.property ?? attributes.name ?? '').toLowerCase() === key.toLowerCase()) return clean(attributes.content);
	}
	return '';
}

function pushSpec(specs, label, value) {
	const cleanLabel = clean(label).replace(/[:：]\s*$/u, '');
	const cleanValue = clean(value);
	if (!cleanLabel || !cleanValue || cleanLabel.length > 120 || cleanValue.length > 700) return;
	if (normalize(cleanLabel) === normalize(cleanValue)) return;
	if (/^(?:купить|цена|наличие|доставка|гарантия|артикул|код товара|производитель|бренд|модель)$/iu.test(cleanLabel)) return;
	if (/^(?:меню|каталог|описание|характеристики|отзывы|документация)$/iu.test(cleanLabel)) return;
	if (/^[A-ZА-ЯЁ]{1,8}[-/][A-ZА-ЯЁ0-9./-]{4,}$/u.test(cleanLabel) && /(?:camera|камера|recorder|регистратор)/iu.test(cleanValue)) return;
	specs.push({ label: cleanLabel, value: cleanValue });
}

function inferredSpecs(row, text) {
	const specs = [
		{ label: 'Модель', value: canonicalModel(row.model || row.name) },
		{ label: 'Тип устройства', value: row.kind === 'recorder' ? 'Видеорегистратор' : 'Камера видеонаблюдения' },
	];
	const value = clean(text);
	const megapixels = value.match(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(?:MP|Мп|мегапиксел)/iu)?.[1];
	if (megapixels) specs.push({ label: 'Разрешение матрицы', value: `${megapixels.replace(',', '.')} Мп` });
	const resolution = value.match(/\b(\d{3,4})\s*[xх×]\s*(\d{3,4})\b/u);
	if (resolution) specs.push({ label: 'Максимальное разрешение', value: `${resolution[1]}×${resolution[2]}` });
	const sensor = value.match(/\b(1\/\d(?:[.,]\d+)?\s*(?:["″'’]|inch|дюйм)?\s*(?:CMOS|КМОП))\b/iu)?.[1];
	if (sensor) specs.push({ label: 'Матрица', value: sensor.replace(',', '.') });
	const lens = value.match(/(?:объектив|фокусн\w*\s+расстояни\w*|lens|focal length)[^.;]{0,45}?(\d+(?:[.,]\d+)?)\s*(?:mm|мм)\b/iu)?.[1];
	if (lens) specs.push({ label: 'Фокусное расстояние', value: `${lens.replace(',', '.')} мм` });
	const illumination = value.match(/(?:ИК[-\s]*подсвет\w*|IR\s*(?:range|distance))[^.;]{0,35}?(?:до|up to|:)?\s*(\d+(?:[.,]\d+)?)\s*(?:m|м)\b/iu)?.[1];
	if (illumination) specs.push({ label: 'Дальность подсветки', value: `${illumination.replace(',', '.')} м` });
	const storage = value.match(/(?:micro\s*SD|кар\w*\s+памят\w*)[^.;]{0,35}?(?:до|up to)?\s*(\d+)\s*(?:GB|ГБ)\b/iu)?.[1];
	if (storage) specs.push({ label: 'Поддержка карт памяти', value: `microSD до ${storage} ГБ` });
	const channels = value.match(/(?:до|up to)?\s*(\d+)\s*(?:-?\s*channel|канал\w*)\b/iu)?.[1];
	if (channels && row.kind === 'recorder') specs.push({ label: 'Количество каналов', value: `${channels} каналов` });
	const hdd = value.match(/(?:до|up to)?\s*(\d+)\s*(?:x|×|шт\.?)?\s*(?:SATA|HDD)\b/iu)?.[1];
	if (hdd && row.kind === 'recorder') specs.push({ label: 'Отсеки для дисков', value: `${hdd} HDD` });
	const protection = value.match(/\bIP(?:6[4-9]|5[4-9]|4[4-9])\b/iu)?.[0];
	if (protection) specs.push({ label: 'Степень защиты', value: protection.toUpperCase() });
	const codecs = [...new Set((value.match(/\b(?:S\+265|H\.?26[45](?:\+)?|MJPEG)\b/giu) ?? []).map((codec) => codec.toUpperCase()))];
	if (codecs.length) specs.push({ label: 'Форматы сжатия видео', value: codecs.join(', ') });
	if (/\bONVIF\b/iu.test(value)) specs.push({ label: 'ONVIF', value: 'Есть' });
	if (/\bWi-?Fi\b/iu.test(value)) specs.push({ label: 'Wi-Fi', value: 'Есть' });
	if (/\bPoE\b/iu.test(value)) specs.push({ label: 'PoE', value: 'Есть' });
	return specs;
}

function parseJsonLdSpecs(html, specs) {
	for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/giu)) {
		try {
			const parsed = JSON.parse(match[1].trim());
			const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
			while (queue.length) {
				const value = queue.shift();
				if (!value || typeof value !== 'object') continue;
				if (Array.isArray(value)) {
					queue.push(...value);
					continue;
				}
				const properties = value.additionalProperty ?? value.additionalProperties;
				for (const property of Array.isArray(properties) ? properties : properties ? [properties] : []) {
					pushSpec(specs, property.name ?? property.propertyID, property.value ?? property.valueReference);
				}
				for (const nested of Object.values(value)) {
					if (nested && typeof nested === 'object') queue.push(nested);
				}
			}
		} catch {
			// Many shops publish malformed JSON-LD; other parsers below remain available.
		}
	}
}

function parseHtmlSpecs(html) {
	const specs = [];
	parseJsonLdSpecs(html, specs);
	for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)) {
		const cells = [...row[1].matchAll(/<(?:th|td)[^>]*>([\s\S]*?)<\/(?:th|td)>/giu)].map((match) => clean(match[1]));
		if (cells.length >= 2) pushSpec(specs, cells[0], cells.slice(1).join(' / '));
	}
	for (const list of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/giu)) {
		pushSpec(specs, list[1], list[2]);
	}
	for (const item of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/giu)) {
		const text = clean(item[1]);
		const separator = text.indexOf(':');
		if (separator > 1 && separator < 100) pushSpec(specs, text.slice(0, separator), text.slice(separator + 1));
	}
	for (const item of html.matchAll(/<(?:p|div)[^>]*>([^<>]{2,120}?)<\/(?:p|div)>\s*<(?:p|div)[^>]*>([^<>]{1,700}?)<\/(?:p|div)>/giu)) {
		pushSpec(specs, item[1], item[2]);
	}
	const unique = new Map();
	for (const spec of specs) {
		const key = normalize(spec.label);
		if (!key || unique.has(key)) continue;
		unique.set(key, spec);
	}
	return [...unique.values()];
}

function titleFromHtml(html, fallback) {
	return clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1])
		|| metaValue(html, 'og:title')
		|| clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1])
		|| fallback;
}

async function readCandidate(row, candidate) {
	if (/\.pdf(?:$|[?#])/iu.test(candidate.url)) throw new Error('PDF candidate deferred');
	const buffer = await curlBuffer(candidate.url);
	if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') throw new Error('PDF response deferred');
	const html = decodeHtmlBuffer(buffer);
	const title = titleFromHtml(html, candidate.title);
	const normalizedModel = normalize(canonicalModel(row.model || row.name));
	if (!normalize(`${title} ${candidate.url} ${html.slice(0, 800_000)}`).includes(normalizedModel)) {
		throw new Error('Model mismatch on product page');
	}
	const specs = [
		...parseHtmlSpecs(html),
		...inferredSpecs(row, `${title} ${candidate.snippet} ${metaValue(html, 'description')} ${clean(html).slice(0, 160_000)}`),
	];
	if (specs.length < 5) throw new Error(`Only ${specs.length} structured specifications`);
	const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/iu)?.[1]
		?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/iu)?.[1]
		?? candidate.url;
	return {
		id: Number(row.productId),
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		officialModel: canonicalModel(row.model || row.name),
		url: new URL(canonical, candidate.url).toString(),
		title,
		description: metaValue(html, 'description') || candidate.snippet,
		specs,
		imageUrl: metaValue(html, 'og:image'),
		matchScore: candidate.score,
		sourceType: 'open_web',
		sourceLabel: new URL(candidate.url).hostname,
	};
}

function matchFromSearchResult(row, candidate) {
	const specs = inferredSpecs(row, `${candidate.title} ${candidate.snippet}`);
	if (specs.length < 5) return null;
	return {
		id: Number(row.productId),
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		officialModel: canonicalModel(row.model || row.name),
		url: candidate.url,
		title: candidate.title,
		description: candidate.snippet,
		specs,
		imageUrl: '',
		matchScore: candidate.score,
		sourceType: 'open_web',
		sourceLabel: new URL(candidate.url).hostname,
	};
}

let previous = { matches: [], unmatched: [] };
try {
	previous = JSON.parse(await fs.readFile(outputPath, 'utf8'));
} catch {
	// First run.
}
const completedIds = new Set(refresh ? [] : (previous.matches ?? []).map((entry) => Number(entry.id)));
const matches = [...(previous.matches ?? [])];
const unmatchedById = new Map((previous.unmatched ?? []).map((entry) => [Number(entry.productId), entry]));
let nextIndex = 0;

async function save() {
	matches.sort((left, right) => left.id - right.id);
	const unmatched = [...unmatchedById.values()].sort((left, right) => Number(left.productId) - Number(right.productId));
	const origins = [...new Set(matches.map((match) => new URL(match.url).hostname.toLowerCase()))].sort();
	const result = {
		version: 1,
		generatedAt: new Date().toISOString(),
		sourceType: 'open_web',
		sourceLabel: 'Открытые интернет-источники',
		sourceOrigins: origins,
		scope: {
			targets: targets.length,
			matched: matches.length,
			unmatched: unmatched.length,
		},
		matches,
		unmatched,
	};
	await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

async function worker() {
	while (true) {
		const index = nextIndex;
		nextIndex += 1;
		if (index >= targets.length) return;
		const row = targets[index];
		if (completedIds.has(Number(row.productId))) continue;
		const attempts = [];
		try {
			const candidates = await search(row);
			let match = null;
			for (const candidate of candidates.slice(0, 4)) {
				try {
					match = await readCandidate(row, candidate);
					break;
				} catch (error) {
					attempts.push({ url: candidate.url, reason: String(error?.message ?? error) });
				}
			}
			if (!match && candidates[0]) match = matchFromSearchResult(row, candidates[0]);
			if (match) {
				const existingIndex = matches.findIndex((entry) => Number(entry.id) === Number(row.productId));
				if (existingIndex >= 0) matches.splice(existingIndex, 1);
				matches.push(match);
				unmatchedById.delete(Number(row.productId));
				completedIds.add(Number(row.productId));
			} else {
				unmatchedById.set(Number(row.productId), {
					...row,
					reason: candidates.length ? 'Не удалось извлечь структурированные характеристики из найденных точных страниц.' : 'Точная модель не найдена в веб-поиске.',
					attempts,
				});
			}
		} catch (error) {
			unmatchedById.set(Number(row.productId), {
				...row,
				reason: String(error?.message ?? error),
				attempts,
			});
		}
		await save();
		process.stdout.write(`${JSON.stringify({
			processed: completedIds.size + unmatchedById.size,
			total: targets.length,
			matched: matches.length,
			unmatched: unmatchedById.size,
			productId: row.productId,
		})}\n`);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
await save();
const final = JSON.parse(await fs.readFile(outputPath, 'utf8'));
process.stdout.write(`${JSON.stringify({ outputPath, scope: final.scope, sourceOrigins: final.sourceOrigins }, null, 2)}\n`);
