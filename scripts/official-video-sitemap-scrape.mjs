import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const scopePath = path.resolve(args.get('scope') ?? 'work-catalog-video-20260728/scope.json');
const outputPath = path.resolve(args.get('output') ?? '');
const imageDir = path.resolve(args.get('image-dir') ?? '');
const origin = new URL(args.get('origin') ?? '').origin;
const sitemapUrls = String(args.get('sitemap') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const brandNames = String(args.get('brands') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const kind = args.get('kind') ?? 'both';
const modelPrefixes = String(args.get('model-prefixes') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const sitemapMatch = args.get('sitemap-match') ? new RegExp(args.get('sitemap-match'), 'iu') : null;
const pageMatch = args.get('page-match') ? new RegExp(args.get('page-match'), 'iu') : null;
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 5));
const maxPages = Math.max(1, Number(args.get('max-pages') ?? 3000));
const urlTargetHints = args.get('url-target-hints') === 'true';
if (!outputPath || !imageDir || !origin || !sitemapUrls.length || !brandNames.length) {
	throw new Error('Required: --origin, --sitemap, --brands, --output and --image-dir');
}

const clean = (value) => String(value ?? '')
	.replace(/<br\s*\/?>/giu, '\n')
	.replace(/<[^>]*>/gu, ' ')
	.replace(/&nbsp;|&#160;/giu, ' ')
	.replace(/&quot;/giu, '"')
	.replace(/&amp;/giu, '&')
	.replace(/&laquo;/giu, '«')
	.replace(/&raquo;/giu, '»')
	.replace(/&deg;/giu, '°')
	.replace(/&#(\d+);/gu, (_, number) => String.fromCodePoint(Number(number)))
	.replace(/&#x([\da-f]+);/giu, (_, number) => String.fromCodePoint(Number.parseInt(number, 16)))
	.replace(/\s+/gu, ' ')
	.trim();
const genericWords = /(?:ip|ahd|tvi|cvi|mhd|lte|wi[\s‑-]*fi|видео)?(?:камера|видеокамера|видеорегистратор|регистратор|network camera|camera|nvr|dvr|xvr)/giu;
const normalizeModel = (value) => clean(value)
	.toLowerCase()
	.replace(/\+/gu, 'plus')
	.replace(genericWords, '')
	.replace(/[^a-z0-9а-яё]+/gu, '');
const normalizeName = (value) => normalizeModel(clean(value)
	.replace(/^(?:уличная|внутренняя|купольная|цилиндрическая|поворотная|гибридный|сетевой|цифровая|аналоговая)\s+/iu, '')
	.replace(/\b(?:с|со)\s+.+$/iu, ''));
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const versionOf = (value) => clean(value).toLowerCase()
	.match(/\bv\s*\d+(?:[.,]\d+)?\b/iu)?.[0]?.replace(/\s+/gu, '').replace(',', '.') ?? '';
const lensOf = (value) => {
	const text = clean(value).toLowerCase().replace(/[–—]/gu, '-').replace(',', '.');
	return text.match(/(?:\(|\b)(\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)\s*(?:мм|mm|\))/iu)?.[1]?.replace(/\s+/gu, '') ?? '';
};
const specOf = (value) => clean(value).toLowerCase()
	.match(/\bspec\s*:\s*(.+)$/iu)?.[1]?.replace(/[^a-z0-9]+/gu, '') ?? '';
function variantCodes(value, model) {
	const modelIndex = clean(value).toLowerCase().indexOf(clean(model).toLowerCase());
	if (modelIndex < 0) return [];
	return clean(value)
		.slice(modelIndex + clean(model).length)
		.toLowerCase()
		.replace(/\bspec\s*:/giu, ' ')
		.replace(/\bv(?:jo)?\s*\d+(?:[.,]\d+)?\b/giu, ' ')
		.replace(/\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*(?:мм|mm)?/giu, ' ')
		.split(/[^a-z0-9]+/gu)
		.filter((token) => token && !['ip', 'ahd', 'wifi'].includes(token));
}
function exactVariantTitle(target, title) {
	const rawTitle = clean(title);
	if (!new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(target.model)}(?:$|[^a-z0-9])`, 'iu').test(rawTitle)) return false;
	const targetVersion = versionOf(target.name);
	const titleVersion = versionOf(rawTitle);
	if (targetVersion !== titleVersion) return false;
	const targetLens = lensOf(target.name);
	const titleLens = lensOf(rawTitle);
	if (targetLens && targetLens !== titleLens) return false;
	const targetSpec = specOf(target.name);
	const titleSpec = specOf(rawTitle);
	if (targetSpec && targetSpec !== titleSpec) return false;
	const targetCodes = variantCodes(target.name, target.model);
	const titleCodes = variantCodes(rawTitle, target.model);
	if (targetCodes.some((code) => !titleCodes.includes(code))) return false;
	return true;
}
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchText(url) {
	let lastError;
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeCatalogResearch/1.0)',
					'Accept-Language': 'ru,en;q=0.8',
				},
				redirect: 'follow',
				signal: AbortSignal.timeout(60_000),
			});
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return await response.text();
		} catch (error) {
			lastError = error;
			await sleep(attempt * 800);
		}
	}
	throw lastError;
}

function xmlUrls(xml) {
	return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+)(?:\]\]>)?\s*<\/loc>/giu)]
		.map((match) => clean(match[1]))
		.filter(Boolean);
}

const sitemapQueue = [...sitemapUrls];
const seenSitemaps = new Set();
const pageUrls = new Set();
const sitemapFailures = [];
while (sitemapQueue.length) {
	const url = sitemapQueue.shift();
	if (seenSitemaps.has(url)) continue;
	seenSitemaps.add(url);
	try {
		const xml = await fetchText(url);
		for (const found of xmlUrls(xml)) {
			if (/\.xml(?:$|\?)/iu.test(found)) {
				if (!sitemapMatch || sitemapMatch.test(found)) sitemapQueue.push(found);
				continue;
			}
			try {
				const pageUrl = new URL(found);
				if (pageUrl.origin !== origin) continue;
				if (pageMatch && !pageMatch.test(pageUrl.pathname)) continue;
				pageUrls.add(pageUrl.toString());
			} catch {
				// Ignore malformed sitemap rows.
			}
			if (pageUrls.size >= maxPages) break;
		}
	} catch (error) {
		sitemapFailures.push({ url, error: String(error?.message ?? error) });
	}
	if (pageUrls.size >= maxPages) break;
}

function metaValue(html, names) {
	for (const tag of html.matchAll(/<meta[^>]+>/giu)) {
		const attributes = Object.fromEntries([...tag[0].matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
			.map((match) => [match[1].toLowerCase(), match[2]]));
		if (names.includes(String(attributes.property ?? attributes.name ?? '').toLowerCase()) && attributes.content) {
			return clean(attributes.content);
		}
	}
	return '';
}

function parsePage(url, html) {
	const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1]
		?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1]);
	const description = metaValue(html, ['og:description', 'description']);
	let imageUrl = '';
	for (const tag of html.matchAll(/<img[^>]+>/giu)) {
		const attributes = Object.fromEntries([...tag[0].matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
			.map((match) => [match[1].toLowerCase(), match[2]]));
		if (String(attributes.itemprop ?? '').toLowerCase() === 'image' && attributes.src) {
			imageUrl = attributes.src;
			break;
		}
	}
	imageUrl ||= metaValue(html.replace(/<!--[\s\S]*?-->/gu, ''), ['og:image', 'twitter:image']);
	if (imageUrl) {
		try {
			imageUrl = new URL(imageUrl, url).toString();
		} catch {
			imageUrl = '';
		}
	}
	const specs = [];
	for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)) {
		const cells = [...row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/giu)].map((match) => clean(match[1]));
		if (cells.length < 2) continue;
		const label = cells[0].replace(/:\s*$/u, '');
		const value = cells[1];
		if (label && value && label !== value) specs.push({ label, value });
	}
	for (const match of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value && label !== value) specs.push({ label, value });
	}
	for (const match of html.matchAll(/<div[^>]+class=["'][^"']*details-param-name[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]{0,300}?<div[^>]+class=["'][^"']*details-param-value[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value && label !== value) specs.push({ label, value });
	}
	for (const match of html.matchAll(/<div[^>]+class=["'][^"']*properties-item-name[^"']*["'][^>]*>([\s\S]*?)<\/div>[\s\S]{0,500}?<div[^>]+class=["'][^"']*properties-item-value[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value && label !== value) specs.push({ label, value });
	}
	for (const match of html.matchAll(/<div[^>]+class=["'][^"']*(?:product-teh|characteristic|specification)[^"']*["'][^>]*>\s*(?:<div[^>]*>)?\s*(?:<span[^>]*>)?([\p{L}\d][^<]{1,100})(?:<\/span>)?\s*(?:<\/div>)?\s*<(?:p|div|span)[^>]*>([\s\S]*?)<\/(?:p|div|span)>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value && label !== value) specs.push({ label, value });
	}
	const uniqueSpecs = [...new Map(specs.map((entry) => [`${entry.label}\u0000${entry.value}`, entry])).values()];
	const statedModels = uniqueSpecs
		.filter((entry) => /^(?:модель|наименование|артикул|model(?:\s+no\.?)?|product model)$/iu.test(entry.label))
		.map((entry) => entry.value);
	return { url, title, description, imageUrl, specs: uniqueSpecs, statedModels };
}

const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));
const targets = scope.rows
	.filter((row) => Number.isInteger(row.id) && brandNames.includes(row.brand))
	.filter((row) => kind === 'both' || row.kind === kind)
	.filter((row) => row.model && (!modelPrefixes.length || modelPrefixes.some((prefix) => row.model.toLowerCase().startsWith(prefix.toLowerCase()))))
	.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		normalizedModel: normalizeModel(row.model),
		normalizedName: normalizeName(row.name),
	}));

const targetHints = [...new Set(targets.map((target) => target.normalizedModel).filter((hint) => hint.length >= 4))];
const urls = [...pageUrls].filter((url) => {
	if (!urlTargetHints) return true;
	let normalizedUrl = normalizeModel(url);
	try {
		normalizedUrl = normalizeModel(decodeURIComponent(url));
	} catch {
		// Keep the URL-safe representation.
	}
	return targetHints.some((hint) => normalizedUrl.includes(hint));
});
const pages = [];
const pageFailures = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
	while (cursor < urls.length) {
		const index = cursor;
		cursor += 1;
		const url = urls[index];
		try {
			pages[index] = parsePage(url, await fetchText(url));
		} catch (error) {
			pageFailures.push({ url, error: String(error?.message ?? error) });
		}
	}
}));

const matches = [];
const unmatched = [];
for (const target of targets) {
	const ranked = pages.filter(Boolean).map((page) => {
		const candidates = [page.title, ...page.statedModels].map(normalizeModel).filter(Boolean);
		const exactName = candidates.includes(target.normalizedName);
		const exactModel = candidates.includes(target.normalizedModel);
		const exactVariant = [page.title, ...page.statedModels].some((candidate) => exactVariantTitle(target, candidate));
		const rawPage = `${page.title} ${page.statedModels.join(' ')}`.toLowerCase();
		const rawModel = target.model.toLowerCase();
		const containsModel = rawPage.includes(rawModel);
		const score = exactName
			? 20_000 + target.normalizedName.length
			: exactVariant
				? 15_000 + target.normalizedModel.length
			: exactModel
				? 10_000 + target.normalizedModel.length
				: containsModel
					? target.normalizedModel.length
					: 0;
		return { page, score };
	}).filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);
	const top = ranked[0];
	const tied = top ? ranked.filter((entry) => entry.score === top.score) : [];
	if (!top || top.score < 10_000 || tied.length > 1) {
		unmatched.push({
			...target,
			candidates: ranked.slice(0, 8).map((entry) => ({
				title: entry.page.title,
				url: entry.page.url,
				models: entry.page.statedModels,
				score: entry.score,
			})),
		});
		continue;
	}
	matches.push({
		...target,
		officialModel: top.page.statedModels[0] || top.page.title,
		url: top.page.url,
		title: top.page.title,
		description: top.page.description || `${top.page.title}.`,
		specs: top.page.specs,
		imageUrl: top.page.imageUrl,
		matchScore: top.score,
	});
}

await fs.mkdir(imageDir, { recursive: true });
for (const match of matches) {
	if (!match.imageUrl) continue;
	try {
		const response = await fetch(match.imageUrl, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeCatalogResearch/1.0)' },
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
		const buffer = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get('content-type') ?? '';
		const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
		const filePath = path.join(imageDir, `${match.id}.${extension}`);
		await fs.writeFile(filePath, buffer);
		match.image = {
			localPath: path.relative(path.dirname(outputPath), filePath).replaceAll('\\', '/'),
			bytes: buffer.length,
			sha256: sha256(buffer),
			contentType,
		};
	} catch (error) {
		match.imageError = String(error?.message ?? error);
	}
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	officialOrigin: origin,
	crawl: {
		sitemaps: seenSitemaps.size,
		sitemapFailures,
		urls: urls.length,
		pages: pages.filter(Boolean).length,
		pageFailures,
		maxPagesReached: pageUrls.size >= maxPages,
	},
	scope: {
		targets: targets.length,
		matched: matches.length,
		unmatched: unmatched.length,
		images: matches.filter((entry) => entry.image).length,
	},
	matches,
	unmatched,
};
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, crawl: result.crawl, scope: result.scope }, null, 2));
