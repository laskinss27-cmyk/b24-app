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

const mapPath = path.resolve(args.get('map'));
const outputPath = path.resolve(args.get('output'));
const workDir = path.dirname(outputPath);
const pdfDir = path.join(workDir, `${path.basename(outputPath, '.json')}-pdfs`);
const imageDir = path.join(workDir, `${path.basename(outputPath, '.json')}-images`);
const scopePath = path.resolve(args.get('scope') ?? 'work-catalog-video-20260728/scope.json');
const pythonPath = args.get('python')
	?? 'C:/Users/LapTOP/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const allowedDomains = new Set(String(args.get('allowed-domains') ?? '')
	.split(',')
	.map((value) => value.trim().toLowerCase())
	.filter(Boolean));
const mappings = JSON.parse(await fs.readFile(mapPath, 'utf8'));
const scope = JSON.parse(await fs.readFile(scopePath, 'utf8'));
const rowsById = new Map(scope.rows.map((row) => [Number(row.id), row]));
const clean = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim();
const normalize = (value) => clean(value).toUpperCase().replace(/[^A-Z0-9]/gu, '');

function assertAllowed(url) {
	const hostname = new URL(url).hostname.toLowerCase();
	if (![...allowedDomains].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
		throw new Error(`Domain ${hostname} is not allowed`);
	}
}

async function download(url, destination, expectedPrefix) {
	assertAllowed(url);
	const response = await fetch(url, {
		headers: { 'User-Agent': 'Mozilla/5.0 catalog research' },
		redirect: 'follow',
		signal: AbortSignal.timeout(45_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	assertAllowed(response.url);
	const contentType = response.headers.get('content-type') || '';
	if (!contentType.toLowerCase().startsWith(expectedPrefix)) {
		throw new Error(`Unexpected content type ${contentType}`);
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	await fs.writeFile(destination, bytes);
	return { bytes, contentType };
}

function run(command, commandArgs) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
		});
		const stdout = [];
		const stderr = [];
		child.stdout.on('data', (chunk) => stdout.push(chunk));
		child.stderr.on('data', (chunk) => stderr.push(chunk));
		child.once('error', reject);
		child.once('close', (code) => code === 0
			? resolve(Buffer.concat(stdout).toString('utf8'))
			: reject(new Error(Buffer.concat(stderr).toString('utf8') || `${command} failed (${code})`)));
	});
}

const labelRules = [
	[/^(?:image sensor|sensor|матрица)\b/iu, 'Image Sensor'],
	[/^(?:max(?:imum)?\.?\s*resolution|resolution|разрешение)\b/iu, 'Max. Resolution'],
	[/^(?:lens type|focal length|lens|объектив|фокусное расстояние)\b/iu, 'Lens Type'],
	[/^(?:supplement light range|ir range|illumination distance|дальность.*подсвет)\b/iu, 'Supplement Light Range'],
	[/^(?:video compression|compression|сжатие видео|видеокодек)\b/iu, 'Video Compression'],
	[/^(?:wide dynamic range|wdr|широкий динамический диапазон)\b/iu, 'Wide Dynamic Range'],
	[/^(?:built-in microphone|audio|микрофон|аудио)\b/iu, 'Audio'],
	[/^(?:on-board storage|network storage|storage|micro\s*sd|карта памяти)\b/iu, 'On-board Storage'],
	[/^(?:network interface|ethernet interface|сетевой интерфейс)\b/iu, 'Network Interface'],
	[/^(?:power supply|power|питание)\b/iu, 'Power Supply'],
	[/^(?:power consumption|потребляемая мощность)\b/iu, 'Power Consumption'],
	[/^(?:operating conditions?|operating temperature|рабочая температура)\b/iu, 'Operating Conditions'],
	[/^(?:protection|ingress protection|степень защиты)\b/iu, 'Protection'],
	[/^(?:dimensions?|габариты|размеры)\b/iu, 'Dimensions'],
	[/^(?:weight|вес|масса)\b/iu, 'Weight'],
	[/^(?:video input|ip video input|ip channels?|каналы?)\b/iu, 'IP Channels'],
	[/^(?:incoming bandwidth|incoming bandwidth capacity|входящая пропускная способность)\b/iu, 'Incoming Bandwidth'],
	[/^(?:sata|hdd|hard disk)\b/iu, 'HDD Interface'],
	[/^(?:poe|poe interface|poe ports?)\b/iu, 'PoE Ports'],
];

function extractSpecs(text) {
	const specs = [];
	const seen = new Set();
	const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
	for (const line of lines) {
		const normalizedLine = line.replace(/[•·]/gu, '').trim();
		for (const [pattern, canonicalLabel] of labelRules) {
			if (!pattern.test(normalizedLine)) continue;
			const parts = normalizedLine.split(/\s{2,}|\t+/u).map(clean).filter(Boolean);
			let value = parts.length >= 2 ? parts.slice(1).join(' ') : clean(normalizedLine.replace(pattern, ''));
			value = value.replace(/^[:：\-–—]\s*/u, '');
			if (!value || value.length > 900) break;
			const key = `${canonicalLabel}\0${value}`;
			if (!seen.has(key)) {
				seen.add(key);
				specs.push({ label: canonicalLabel, value });
			}
			break;
		}
		if (specs.length >= 45) break;
	}
	return specs;
}

await fs.mkdir(pdfDir, { recursive: true });
await fs.mkdir(imageDir, { recursive: true });
const matches = [];
const unmatched = [];
for (const mapping of mappings) {
	const row = rowsById.get(Number(mapping.id));
	if (!row) throw new Error(`Scope row ${mapping.id} not found`);
	try {
		const pdfPath = path.join(pdfDir, `${mapping.id}.pdf`);
		const cached = await fs.stat(pdfPath).catch(() => null);
		if (!cached || cached.size < 1024) await download(mapping.pdfUrl, pdfPath, 'application/pdf');
		const text = await run(pythonPath, [
			'-c',
			'from pypdf import PdfReader; import sys; print("\\n".join((p.extract_text() or "") for p in PdfReader(sys.argv[1]).pages))',
			pdfPath,
		]);
		const expected = normalize(mapping.validationModel ?? mapping.officialModel ?? row.model);
		if (!expected || !normalize(text).includes(expected)) {
			throw new Error(`Exact model ${mapping.validationModel ?? mapping.officialModel ?? row.model} not found in PDF`);
		}
		let image = null;
		if (mapping.imageUrl) {
			try {
				const parsed = new URL(mapping.imageUrl);
				const ext = path.extname(parsed.pathname) || '.png';
				const imagePath = path.join(imageDir, `${mapping.id}${ext}`);
				await download(mapping.imageUrl, imagePath, 'image/');
				image = { localPath: path.relative(workDir, imagePath).replaceAll('\\', '/') };
			} catch {
				image = null;
			}
		} else if (mapping.extractPdfImage !== false) {
			try {
				const imageBase = path.join(imageDir, String(mapping.id));
				const extractedPath = clean(await run(pythonPath, [
					'-c',
					[
						'from pypdf import PdfReader',
						'import os,sys',
						'r=PdfReader(sys.argv[1])',
						'imgs=list(r.pages[0].images)',
						'imgs=sorted(imgs,key=lambda i:len(i.data),reverse=True)',
						'assert imgs, "No raster images in first PDF page"',
						'i=imgs[0]',
						'ext=os.path.splitext(i.name or "")[1].lower() or ".png"',
						'out=sys.argv[2]+ext',
						'open(out,"wb").write(i.data)',
						'print(out)',
					].join(';'),
					pdfPath,
					imageBase,
				]));
				if (extractedPath) image = { localPath: path.relative(workDir, extractedPath).replaceAll('\\', '/') };
			} catch {
				image = null;
			}
		}
		const specs = extractSpecs(text);
		if (mapping.specOverrides) {
			for (const [label, value] of Object.entries(mapping.specOverrides)) {
				const existing = specs.find((spec) => spec.label === label);
				if (existing) existing.value = value;
				else specs.unshift({ label, value });
			}
		}
		matches.push({
			id: Number(mapping.id),
			kind: row.kind,
			name: row.name,
			model: row.model,
			brand: row.brand,
			officialModel: mapping.officialModel ?? row.model,
			url: mapping.productUrl ?? mapping.pdfUrl,
			pdfUrl: mapping.pdfUrl,
			title: mapping.title ?? `${row.brand} ${mapping.officialModel ?? row.model}`,
			description: mapping.title ?? `${row.brand} ${mapping.officialModel ?? row.model}`,
			specs,
			imageUrl: mapping.imageUrl ?? '',
			image,
			matchScore: 20_000,
		});
	} catch (error) {
		unmatched.push({
			id: Number(mapping.id),
			kind: row.kind,
			name: row.name,
			model: row.model,
			brand: row.brand,
			url: mapping.pdfUrl,
			reason: String(error?.message ?? error),
		});
	}
}

const result = {
	version: 1,
	generatedAt: new Date().toISOString(),
	officialOrigins: [...allowedDomains],
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
console.log(JSON.stringify({ outputPath, matched: matches.length, unmatched: unmatched.length }, null, 2));
