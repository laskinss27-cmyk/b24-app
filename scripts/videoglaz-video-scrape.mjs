import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index];
	const value = process.argv[index + 1];
	if (!key?.startsWith('--') || value == null) throw new Error('Arguments must use --name value');
	args.set(key.slice(2), value);
}

const inputPath = path.resolve(args.get('input') ?? 'work-catalog-video-20260728/unmatched-current-stock.json');
const outputPath = path.resolve(args.get('output') ?? 'work-catalog-video-20260728/videoglaz-source.json');
const imageDir = path.resolve(args.get('image-dir') ?? 'work-catalog-video-20260728/videoglaz-source-images');
const concurrency = Math.max(1, Math.min(4, Number(args.get('concurrency') ?? 2)));
const baseUrl = 'https://videoglaz.ru';

const source = JSON.parse(await fs.readFile(inputPath, 'utf8'));
const targets = Array.isArray(source.blocked) ? source.blocked : [];
await fs.mkdir(imageDir, { recursive: true });

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
	.toLocaleLowerCase('ru-RU')
	.replace(/[–—−]/gu, '-')
	.replace(/[^a-zа-яё0-9]+/giu, '');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const execFileAsync = promisify(execFile);

async function curlBuffer(url, form = null) {
	const curlArgs = [
		'-sS',
		'-L',
		'--max-time', '45',
		'--retry', '1',
		'--retry-delay', '1',
		'-A', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36',
		'-H', 'Accept-Language: ru,en;q=0.8',
	];
	if (form) {
		curlArgs.push('-X', 'POST', '-H', 'X-Requested-With: XMLHttpRequest');
		for (const [key, value] of Object.entries(form)) {
			curlArgs.push('--data-urlencode', `${key}=${value}`);
		}
	}
	curlArgs.push(url);
	const { stdout } = await execFileAsync('curl.exe', curlArgs, {
		encoding: 'buffer',
		maxBuffer: 25 * 1024 * 1024,
		timeout: 150_000,
		windowsHide: true,
	});
	return Buffer.from(stdout);
}

function candidateQueries(row) {
	return [clean(row.model || row.name)].filter((value) => value.length >= 3);
}

function parseCandidates(html) {
	const candidates = [];
	for (const match of html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*>\s*<strong[^>]*>([\s\S]*?)<\/strong>/giu)) {
		const url = new URL(match[1], baseUrl).toString();
		if (new URL(url).hostname !== 'videoglaz.ru') continue;
		const title = clean(match[2]);
		if (title) candidates.push({ url, title });
	}
	return [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()];
}

function candidateScore(row, candidate) {
	const model = normalize(row.model);
	const title = normalize(candidate.title);
	const name = normalize(row.name);
	if (model.length >= 4 && title.includes(model)) return 100_000 + model.length;
	if (name.length >= 8 && title.includes(name)) return 90_000 + name.length;
	const modelParts = clean(row.model).split(/[/(]/u).map(normalize).filter((value) => value.length >= 4);
	const matchedLength = modelParts.filter((part) => title.includes(part)).reduce((sum, part) => sum + part.length, 0);
	return matchedLength >= Math.max(5, Math.floor(model.length * 0.65)) ? 50_000 + matchedLength : 0;
}

async function searchTarget(row) {
	const allCandidates = [];
	for (const query of candidateQueries(row)) {
		const response = await curlBuffer(`${baseUrl}/suggestions`, {
			str: query,
			isTemplateB2b: 'false',
			'X-Only-Action': 'true',
		});
		const json = JSON.parse(response.toString('utf8'));
		allCandidates.push(...parseCandidates(String(json.html ?? '')));
		const scored = [...new Map(allCandidates.map((candidate) => [candidate.url, candidate])).values()]
			.map((candidate) => ({ ...candidate, score: candidateScore(row, candidate) }))
			.filter((candidate) => candidate.score > 0)
			.sort((left, right) => right.score - left.score);
		if (scored[0]?.score >= 100_000) return scored[0];
	}
	return [...new Map(allCandidates.map((candidate) => [candidate.url, candidate])).values()]
		.map((candidate) => ({ ...candidate, score: candidateScore(row, candidate) }))
		.filter((candidate) => candidate.score > 0)
		.sort((left, right) => right.score - left.score)[0] ?? null;
}

function metaValue(html, key) {
	for (const tag of html.matchAll(/<meta[^>]+>/giu)) {
		const attributes = Object.fromEntries([...tag[0].matchAll(/([:\w-]+)=["']([^"']*)["']/giu)]
			.map((match) => [match[1].toLowerCase(), match[2]]));
		if (String(attributes.property ?? attributes.name ?? '').toLowerCase() === key.toLowerCase()) {
			return clean(attributes.content);
		}
	}
	return '';
}

function parseSpecs(html) {
	const specs = [];
	const technicalBlock = html.match(/id=["']tth["'][\s\S]*?<div[^>]+class=["'][^"']*content-cut__text[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu)?.[1] ?? '';
	const fragments = technicalBlock
		.replace(/<br\s*\/?>\s*(?=<li)/giu, '')
		.split(/<li[^>]*>/iu)
		.slice(1);
	for (const fragment of fragments) {
		const text = clean(fragment.split(/<\/li>|<\/ul>/iu)[0]);
		const separator = text.indexOf(':');
		if (separator <= 0) continue;
		const label = clean(text.slice(0, separator));
		const value = clean(text.slice(separator + 1));
		if (label && value) specs.push({ label, value });
	}
	for (const table of html.matchAll(/<table[^>]+class=["'][^"']*\btech\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/giu)) {
		for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/giu)) {
			const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/giu)].map((match) => clean(match[1]));
			if (cells.length >= 2 && cells[0] && cells[1]) specs.push({ label: cells[0], value: cells[1] });
		}
	}
	return [...new Map(specs.map((spec) => [normalize(spec.label), spec])).values()];
}

async function readProduct(row, candidate) {
	const html = (await curlBuffer(candidate.url)).toString('utf8');
	const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/iu)?.[1]) || candidate.title;
	const model = normalize(row.model);
	if (model.length >= 4 && !normalize(`${title} ${html}`).includes(model)) {
		throw new Error('Model mismatch on product page');
	}
	const specs = parseSpecs(html);
	if (specs.length < 2) throw new Error('Not enough structured specifications');
	const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/iu)?.[1] ?? candidate.url;
	const description = metaValue(html, 'description');
	const imageUrl = metaValue(html, 'og:image');
	const match = {
		id: Number(row.productId),
		kind: row.kind,
		name: row.name,
		model: row.model,
		brand: row.brand,
		officialModel: row.model,
		url: new URL(canonical, baseUrl).toString(),
		title,
		description,
		specs,
		imageUrl: imageUrl ? new URL(imageUrl, baseUrl).toString() : '',
		matchScore: candidate.score,
		sourceType: 'dealer_archive',
		sourceLabel: 'VideoGlaz',
	};
	if (match.imageUrl && new URL(match.imageUrl).hostname.endsWith('videoglaz.ru')) {
		try {
			const buffer = await curlBuffer(match.imageUrl);
			const extension = path.extname(new URL(match.imageUrl).pathname).slice(1).toLowerCase() || 'jpg';
			const contentType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
			const filePath = path.join(imageDir, `${row.productId}.${extension}`);
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
	return match;
}

const matches = [];
const unmatched = [];
let nextIndex = 0;

async function worker() {
	while (true) {
		const index = nextIndex;
		nextIndex += 1;
		if (index >= targets.length) return;
		const row = targets[index];
		try {
			const candidate = await searchTarget(row);
			if (!candidate) {
				unmatched.push({ ...row, reason: 'Точная модель не найдена в поиске VideoGlaz.' });
				continue;
			}
			matches.push(await readProduct(row, candidate));
		} catch (error) {
			unmatched.push({ ...row, reason: String(error?.message ?? error) });
		}
		process.stdout.write(`${JSON.stringify({
			processed: matches.length + unmatched.length,
			total: targets.length,
			matched: matches.length,
			unmatched: unmatched.length,
			productId: row.productId,
		})}\n`);
	}
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
matches.sort((left, right) => left.id - right.id);
unmatched.sort((left, right) => Number(left.productId) - Number(right.productId));

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	sourceType: 'dealer_archive',
	sourceLabel: 'VideoGlaz',
	sourceOrigin: 'videoglaz.ru',
	scope: {
		targets: targets.length,
		matched: matches.length,
		unmatched: unmatched.length,
		images: matches.filter((match) => match.image).length,
	},
	matches,
	unmatched,
};
await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ outputPath, scope: result.scope }, null, 2)}\n`);
