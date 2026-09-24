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
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/fox-official.json');
const imageDir = path.resolve(args.get('image-dir') ?? 'work-catalog-video-20260728/fox-images');
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 3));
const delayMs = Math.max(0, Number(args.get('delay-ms') ?? 100));
const maxPages = Math.max(1, Number(args.get('max-pages') ?? 700));
const origin = 'https://fox-cctv.ru';

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
	.replace(/\([^)]*[а-яё][^)]*\)/giu, '')
	.replace(/[^a-z0-9]+/gu, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeUrl(href) {
	try {
		const url = new URL(clean(href), `${origin}/`);
		if (url.origin !== origin || !url.pathname.startsWith('/products/')) return null;
		if (/\.(?:pdf|zip|rar|jpg|jpeg|png|webp|svgz?)$/iu.test(url.pathname)) return null;
		url.hash = '';
		for (const key of [...url.searchParams.keys()]) url.searchParams.delete(key);
		return url.toString();
	} catch {
		return null;
	}
}

function parsePage(url, html) {
	const table = html.match(/<table[^>]+class=["'][^"']*table_list[^"']*["'][^>]*>([\s\S]*?)<\/table>/iu)?.[1] ?? '';
	const specs = [];
	for (const match of table.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value) specs.push({ label, value });
	}
	const model = specs.find((entry) => /^(?:наименование|модель)$/iu.test(entry.label))?.value ?? '';
	const description = clean(html.match(/<p[^>]+class=["'][^"']*product_description_text[^"']*["'][^>]*>([\s\S]*?)<\/p>/iu)?.[1]);
	const imagePath = html.match(/<img[^>]+class=["'][^"']*cb-catalog_product-el_img[^"']*["'][^>]+src=["']([^"']+)["']/iu)?.[1]
		?? html.match(/<img[^>]+src=["']([^"']+)["'][^>]+class=["'][^"']*cb-catalog_product-el_img[^"']*["']/iu)?.[1]
		?? '';
	let imageUrl = '';
	if (imagePath) {
		try {
			imageUrl = new URL(imagePath, `${origin}/`).toString();
		} catch {
			imageUrl = '';
		}
	}
	const links = [...html.matchAll(/href=["']([^"'#]+)["']/giu)]
		.map((match) => normalizeUrl(match[1]))
		.filter(Boolean);
	return {
		url,
		model,
		description,
		specs,
		imageUrl,
		isProduct: specs.length >= 3 && Boolean(model),
		links: [...new Set(links)],
	};
}

async function fetchText(url) {
	let lastError;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeCatalogResearch/1.0)',
					'Accept-Language': 'ru,en;q=0.8',
				},
				redirect: 'follow',
				signal: AbortSignal.timeout(45_000),
			});
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return await response.text();
		} catch (error) {
			lastError = error;
			await sleep(attempt * 700);
		}
	}
	throw lastError;
}

const queue = [`${origin}/products/`];
const queued = new Set(queue);
const visited = new Set();
const pages = [];
const failures = [];

async function worker() {
	while (true) {
		const url = queue.shift();
		if (!url || visited.size >= maxPages) return;
		if (visited.has(url)) continue;
		visited.add(url);
		try {
			const page = parsePage(url, await fetchText(url));
			if (page.isProduct) pages.push(page);
			for (const link of page.links) {
				if (!visited.has(link) && !queued.has(link) && queued.size < maxPages * 3) {
					queued.add(link);
					queue.push(link);
				}
			}
		} catch (error) {
			failures.push({ url, error: String(error?.message ?? error) });
		}
		await sleep(delayMs);
	}
}
await Promise.all(Array.from({ length: concurrency }, worker));

const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));
const targets = scope.rows
	.filter((row) => Number.isInteger(row.id) && row.brand === 'FOX')
	.filter((row) => /^FX-/iu.test(row.model) && !/^FX-KIT/iu.test(row.model))
	.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		normalizedModel: normalizeModel(row.model),
	}));
const officialModels = pages.map((page) => ({
	page,
	normalizedModel: normalizeModel(page.model),
}));
const matches = [];
const unmatched = [];
for (const target of targets) {
	const official = officialModels.find((entry) => entry.normalizedModel === target.normalizedModel);
	if (!official) {
		unmatched.push(target);
		continue;
	}
	matches.push({
		...target,
		officialModel: official.page.model,
		url: official.page.url,
		description: official.page.description,
		specs: official.page.specs,
		imageUrl: official.page.imageUrl,
	});
}

await fs.mkdir(imageDir, { recursive: true });
for (const match of matches) {
	if (!match.imageUrl) continue;
	try {
		const response = await fetch(match.imageUrl, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SmartHomeCatalogResearch/1.0)' },
			signal: AbortSignal.timeout(45_000),
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
		visited: visited.size,
		productPages: pages.length,
		failures,
		maxPagesReached: visited.size >= maxPages,
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
