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
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/redline-official.json');
const imageDir = path.resolve(args.get('image-dir') ?? 'work-catalog-video-20260728/redline-images');
const concurrency = Math.max(1, Number(args.get('concurrency') ?? 3));
const delayMs = Math.max(0, Number(args.get('delay-ms') ?? 150));
const maxPages = Math.max(1, Number(args.get('max-pages') ?? 1500));
const origin = 'https://redline-cctv.ru';
const catalogPrefix = '/catalog/video_observation/';

const seeds = [
	`${origin}/sitemap/`,
	`${origin}${catalogPrefix}ip-cams/`,
	`${origin}${catalogPrefix}ip-cams/seriya_facedetection/`,
	`${origin}${catalogPrefix}ip-cams/seriya_wdr/`,
	`${origin}${catalogPrefix}ip-cams/seriya_alert/`,
	`${origin}${catalogPrefix}ip-cams/practicam/`,
	`${origin}${catalogPrefix}kamery_ahd/`,
	`${origin}${catalogPrefix}kamery_ahd/kamery_mhd/`,
	`${origin}${catalogPrefix}setevye_videoregistratory_nvr/`,
	`${origin}${catalogPrefix}mhd_videoregistratory/`,
	`${origin}${catalogPrefix}arhiv_oborudovaniya_redline/`,
	`${origin}${catalogPrefix}archive/`,
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
	.replace(/[а-яё]/gu, (letter) => ({
		а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
		и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
		с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
		ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
	}[letter]))
	.replace(/(?:redline|practicam)/gu, '')
	.replace(/[^a-z0-9]+/gu, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function normalizeUrl(href) {
	try {
		const url = new URL(clean(href), `${origin}/`);
		if (url.origin !== origin || !url.pathname.startsWith(catalogPrefix)) return null;
		url.hash = '';
		for (const key of [...url.searchParams.keys()]) {
			if (!/^PAGEN_/u.test(key)) url.searchParams.delete(key);
		}
		return url.toString();
	} catch {
		return null;
	}
}

function parsePage(url, html) {
	const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1]);
	const profile = html.match(/<div[^>]+id=["']profile["'][^>]*>([\s\S]*?)<\/table>/iu)?.[1] ?? '';
	const specs = [];
	for (const match of profile.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value) specs.push({ label, value });
	}
	const model = specs.find((entry) => /^модель$/iu.test(entry.label))?.value ?? '';
	const imageMatches = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/giu)]
		.map((match) => match[1])
		.filter((value) => /assets\/images\/(?:cameras_katalog|catalog|video)/iu.test(value)
			&& !/(?:banner|logo|icon|cache\/images)/iu.test(value));
	let imageUrl = '';
	if (imageMatches[0]) {
		try {
			imageUrl = new URL(imageMatches[0], `${origin}/`).toString();
		} catch {
			imageUrl = '';
		}
	}
	const links = [...html.matchAll(/href=["']([^"'#]+)["']/giu)]
		.map((match) => normalizeUrl(match[1]))
		.filter(Boolean);
	return {
		url,
		title,
		model,
		specs,
		imageUrl,
		isProduct: specs.length >= 3 && Boolean(model || title),
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

const queue = [...seeds];
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
const targetPrefixes = /^(?:RL-(?:AHD|IP|MHD|NVR)|PT-(?:MHD|IPC|XVR))/iu;
const targets = scope.rows
	.filter((row) => Number.isInteger(row.id))
	.filter((row) => targetPrefixes.test(row.model))
	.map((row) => ({
		id: row.id,
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		normalizedModel: normalizeModel(row.model),
	}));

const officialModels = [];
for (const page of pages) {
	const candidates = new Set([
		page.model,
		...(page.title.match(/\b(?:RL|PT)-(?:[A-Z0-9]+[.-]?)+(?:\s*\([^)]+\))?/giu) ?? []),
	]);
	for (const candidate of candidates) {
		const normalizedModel = normalizeModel(candidate);
		if (normalizedModel) officialModels.push({ candidate, normalizedModel, page });
	}
}

function scoreMatch(target, official) {
	if (target.normalizedModel === official.normalizedModel) return 10_000 + target.normalizedModel.length;
	if (target.normalizedModel.startsWith(official.normalizedModel) || official.normalizedModel.startsWith(target.normalizedModel)) {
		return Math.min(target.normalizedModel.length, official.normalizedModel.length);
	}
	return 0;
}

const matches = [];
const unmatched = [];
for (const target of targets) {
	const ranked = officialModels
		.map((official) => ({ official, score: scoreMatch(target, official) }))
		.filter((entry) => entry.score > 0)
		.sort((left, right) => right.score - left.score || right.official.normalizedModel.length - left.official.normalizedModel.length);
	const top = ranked[0];
	const tied = top ? ranked.filter((entry) => entry.score === top.score) : [];
	if (!top || (top.score < 10_000 && tied.length > 1)) {
		unmatched.push({ ...target, candidates: tied.slice(0, 5).map((entry) => ({
			model: entry.official.candidate,
			url: entry.official.page.url,
			score: entry.score,
		})) });
		continue;
	}
	matches.push({
		...target,
		officialModel: top.official.candidate,
		url: top.official.page.url,
		title: top.official.page.title,
		specs: top.official.page.specs,
		imageUrl: top.official.page.imageUrl,
		matchScore: top.score,
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
console.log(JSON.stringify({
	outputPath,
	crawl: result.crawl,
	scope: result.scope,
}, null, 2));
