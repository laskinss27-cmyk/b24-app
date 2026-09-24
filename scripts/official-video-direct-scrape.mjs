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
const mapPath = path.resolve(args.get('map') ?? '');
const outputPath = path.resolve(args.get('output') ?? '');
const imageDir = path.resolve(args.get('image-dir') ?? '');
const allowedDomains = String(args.get('allowed-domains') ?? '')
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean);
if (!mapPath || !outputPath || !imageDir || !allowedDomains.length) {
	throw new Error('Required: --map, --output, --image-dir and --allowed-domains');
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
const normalize = (value) => clean(value)
	.toLowerCase()
	.replace(/[–—]/gu, '-')
	.replace(/[^a-z0-9а-яё]+/gu, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function domainAllowed(hostname) {
	const host = hostname.toLowerCase();
	return allowedDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

async function fetchResponse(url) {
	let lastError;
	for (let attempt = 1; attempt <= 4; attempt += 1) {
		try {
			const response = await fetch(url, {
				headers: {
					'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
					'Accept-Language': 'ru,en;q=0.8',
				},
				redirect: 'follow',
				signal: AbortSignal.timeout(90_000),
			});
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			return response;
		} catch (error) {
			lastError = error;
			await sleep(attempt * 900);
		}
	}
	throw lastError;
}

function attributesFromTag(tag) {
	return Object.fromEntries([...tag.matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
		.map((match) => [match[1].toLowerCase(), match[2]]));
}

function metaValue(html, names) {
	const uncommented = html.replace(/<!--[\s\S]*?-->/gu, '');
	for (const tag of uncommented.matchAll(/<meta[^>]+>/giu)) {
		const attributes = attributesFromTag(tag[0]);
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
		const attributes = attributesFromTag(tag[0]);
		if (String(attributes.itemprop ?? '').toLowerCase() === 'image' && attributes.src) {
			imageUrl = attributes.src;
			break;
		}
	}
	imageUrl ||= metaValue(html, ['og:image', 'twitter:image']);
	if (imageUrl) imageUrl = new URL(imageUrl, url).toString();

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
	for (const match of html.matchAll(/"specName"\s*:\s*"([^"]+)"[\s\S]{0,300}?"specValue"\s*:\s*"([^"]+)"/giu)) {
		const label = clean(match[1]).replace(/:\s*$/u, '');
		const value = clean(match[2]);
		if (label && value && label !== value) specs.push({ label, value });
	}
	return {
		title,
		description,
		imageUrl,
		specs: [...new Map(specs.map((entry) => [`${entry.label}\u0000${entry.value}`, entry])).values()],
		pageText: clean(html),
	};
}

const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));
const mappings = JSON.parse(await fs.readFile(mapPath, 'utf8'));
const rowsById = new Map(scope.rows.filter((row) => Number.isInteger(row.id)).map((row) => [row.id, row]));
const matches = [];
const unmatched = [];
await fs.mkdir(imageDir, { recursive: true });

for (const mapping of mappings) {
	const row = rowsById.get(Number(mapping.id));
	if (!row) {
		unmatched.push({ id: Number(mapping.id), url: mapping.url, reason: 'Карточка отсутствует в локальном снимке каталога.' });
		continue;
	}
	try {
		const requestedUrl = new URL(mapping.url);
		if (!domainAllowed(requestedUrl.hostname)) throw new Error(`Non-official domain blocked: ${requestedUrl.hostname}`);
		const response = await fetchResponse(requestedUrl);
		if (!domainAllowed(new URL(response.url).hostname)) throw new Error(`Redirect outside official domains blocked: ${response.url}`);
		const html = await response.text();
		const page = parsePage(response.url, html);
		const modelCandidates = [row.model, mapping.officialModel].map(normalize).filter(Boolean);
		if (!modelCandidates.some((model) => normalize(`${page.title} ${page.pageText}`).includes(model))) {
			throw new Error('Exact model is not present on the official page');
		}
		const match = {
			id: row.id,
			kind: row.kind,
			name: row.name,
			model: row.model,
			brand: row.brand,
			officialModel: mapping.officialModel || row.model,
			url: response.url,
			title: page.title,
			description: page.description || `${page.title}.`,
			specs: page.specs,
			imageUrl: page.imageUrl,
			matchScore: 20_000,
		};
		if (page.imageUrl) {
			try {
				const imageResponse = await fetchResponse(page.imageUrl);
				if (!domainAllowed(new URL(imageResponse.url).hostname)) throw new Error(`Image redirect outside official domains blocked: ${imageResponse.url}`);
				const buffer = Buffer.from(await imageResponse.arrayBuffer());
				const contentType = imageResponse.headers.get('content-type') ?? '';
				const extension = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
				const filePath = path.join(imageDir, `${row.id}.${extension}`);
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
		matches.push(match);
	} catch (error) {
		unmatched.push({
			id: row.id,
			kind: row.kind,
			name: row.name,
			model: row.model,
			brand: row.brand,
			url: mapping.url,
			reason: String(error?.message ?? error),
		});
	}
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	officialOrigins: allowedDomains,
	scope: {
		targets: mappings.length,
		matched: matches.length,
		unmatched: unmatched.length,
		images: matches.filter((match) => match.image).length,
	},
	matches,
	unmatched,
};
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, scope: result.scope }, null, 2));
