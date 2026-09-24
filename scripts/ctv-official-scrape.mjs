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
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/ctv-official.json');
const imageDir = path.resolve(args.get('image-dir') ?? 'work-catalog-video-20260728/ctv-images');
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 4));
const origin = 'https://ctvcctv.ru';
const sitemapUrl = `${origin}/products-sitemap.xml`;

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
const normalizeModel = (value) => clean(value)
	.toLowerCase()
	.replace(/\+/gu, 'plus')
	.replace(/(?:ctv|homecam|cam|wi[\s‑-]*fi|видеокамера)/giu, '')
	.replace(/[^a-z0-9а-яё]+/gu, '');
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

function parsePage(url, html) {
	const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1]);
	const metaTags = [...html.matchAll(/<meta[^>]+>/giu)].map((match) => match[0]);
	const metaValue = (names) => {
		for (const tag of metaTags) {
			const attributes = Object.fromEntries([...tag.matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
				.map((match) => [match[1].toLowerCase(), match[2]]));
			if (names.includes(String(attributes.property ?? attributes.name ?? '').toLowerCase()) && attributes.content) {
				return clean(attributes.content);
			}
		}
		return '';
	};
	const description = clean(
		metaValue(['og:description', 'description']),
	);
	const fallbackImage = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/giu)]
		.map((match) => match[1])
		.find((value) => /wp-content\/uploads/iu.test(value) && !/(?:logo|icon|certificate|sertifikat|appstore|google)/iu.test(value));
	const imageUrl = clean(metaValue(['og:image', 'twitter:image']) || fallbackImage);
	const specs = [];
	for (const match of html.matchAll(/<div[^>]+class=["']product-teh["'][^>]*>\s*<div[^>]+class=["']product-teh-name["'][^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>\s*<\/div>\s*<p[^>]*>([\s\S]*?)<\/p>\s*<\/div>/giu)) {
		const label = clean(match[1]);
		const value = clean(match[2]);
		if (label && value) specs.push({ label, value });
	}
	return { url, title, description, imageUrl, specs };
}

const sitemap = await fetchText(sitemapUrl);
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/giu)].map((match) => clean(match[1]));
const pages = [];
const failures = [];
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
	while (cursor < urls.length) {
		const index = cursor;
		cursor += 1;
		const url = urls[index];
		try {
			pages[index] = parsePage(url, await fetchText(url));
		} catch (error) {
			failures.push({ url, error: String(error?.message ?? error) });
		}
	}
}));

const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));
const targets = scope.rows
	.filter((row) => Number.isInteger(row.id) && row.brand === 'CTV' && row.kind === 'camera')
	.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		normalizedModel: normalizeModel(row.model || row.name),
	}));
const matches = [];
const unmatched = [];
for (const target of targets) {
	const ranked = pages
		.filter(Boolean)
		.map((page) => {
			const normalizedTitle = normalizeModel(page.title);
			const exact = normalizedTitle === target.normalizedModel;
			const contains = normalizedTitle.includes(target.normalizedModel) || target.normalizedModel.includes(normalizedTitle);
			return { page, score: exact ? 10_000 + target.normalizedModel.length : contains ? Math.min(normalizedTitle.length, target.normalizedModel.length) : 0 };
		})
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score);
	const top = ranked[0];
	if (!top || top.score < 10_000) {
		unmatched.push({
			...target,
			candidates: ranked.slice(0, 5).map((entry) => ({ title: entry.page.title, url: entry.page.url, score: entry.score })),
		});
		continue;
	}
	matches.push({
		...target,
		officialModel: top.page.title,
		url: top.page.url,
		description: top.page.description || `${top.page.title}.`,
		specs: top.page.specs,
		imageUrl: top.page.imageUrl,
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
	crawl: { sitemapUrl, urls: urls.length, pages: pages.filter(Boolean).length, failures },
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
