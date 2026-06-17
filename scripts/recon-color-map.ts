/**
 * Read-only: словарь «хэш property358 → цвет» эвристикой по каталогу:
 * у многих вариаций цвет написан словом в имени — собираем пары и голосуем.
 * Запуск: npx tsx scripts/recon-color-map.ts
 */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	let last: unknown;
	for (let a = 1; a <= 5; a++) {
		try {
			const { stdout } = await execFileP('curl.exe', [
				'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
				'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
			], { maxBuffer: 32 * 1024 * 1024 });
			const j = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
			if (j.error) throw new Error(`${j.error}: ${j.error_description ?? ''}`);
			return j.result as T;
		} catch (e) { last = e; await new Promise((r) => setTimeout(r, a * 700)); }
	}
	throw last;
}

const COLOR_WORDS: Array<[RegExp, string]> = [
	[/бел(ый|ая|ое|ые)/i, 'Белый'],
	[/ч[её]рн(ый|ая|ое|ые)/i, 'Чёрный'],
	[/красн(ый|ая|ое|ые)/i, 'Красный'],
	[/голуб(ой|ая|ое|ые)/i, 'Голубой'],
	[/син(ий|яя|ее|ие)/i, 'Синий'],
	[/фиолетов(ый|ая|ое|ые)/i, 'Фиолетовый'],
	[/бежев(ый|ая|ое|ые)/i, 'Бежевый'],
	[/серебр(о|истый|истая)/i, 'Серебро'],
	[/сер(ый|ая|ое|ые)/i, 'Серый'],
	[/бронз(а|овый|овая)/i, 'Бронза'],
	[/золот(о|ой|истый)/i, 'Золото'],
	[/коричнев(ый|ая|ое|ые)/i, 'Коричневый'],
	[/зел[её]н(ый|ая|ое|ые)/i, 'Зелёный'],
	[/графит/i, 'Графит'],
	[/антрацит/i, 'Антрацит'],
];

(async () => {
	const rows: Array<Record<string, unknown>> = [];
	let start: number | undefined = 0;
	while (start !== undefined) {
		const r = await call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
			filter: { iblockId: 26 }, select: ['id', 'iblockId', 'name', 'property358'], order: { id: 'ASC' }, start,
		});
		const page = r?.products ?? [];
		rows.push(...page);
		start = page.length === 50 ? (start as number) + 50 : undefined;
	}
	console.log(`вариаций: ${rows.length}`);

	// голосование: хэш → {цвет: счётчик}
	const votes = new Map<string, Map<string, number>>();
	let withHash = 0;
	for (const p of rows) {
		const prop = p['property358'] as { value?: unknown } | null;
		const hash = prop?.value != null ? String(prop.value) : '';
		if (!hash) continue;
		withHash++;
		const name = String(p['name'] ?? '');
		for (const [re, color] of COLOR_WORDS) {
			if (re.test(name)) {
				const v = votes.get(hash) ?? new Map<string, number>();
				v.set(color, (v.get(color) ?? 0) + 1);
				votes.set(hash, v);
				break;
			}
		}
	}
	console.log(`со значением цвета: ${withHash}; хэшей с голосами: ${votes.size}`);

	console.log('\n=== СЛОВАРЬ (хэш → цвет по большинству голосов) ===');
	const dict: Record<string, string> = {};
	for (const [hash, v] of votes) {
		const sorted = [...v.entries()].sort((a, b) => b[1] - a[1]);
		const [winner, n] = sorted[0]!;
		const total = [...v.values()].reduce((a, x) => a + x, 0);
		dict[hash] = winner;
		console.log(`  '${hash}': '${winner}', // голосов ${n}/${total}${sorted.length > 1 ? ` (ещё: ${sorted.slice(1).map(([c, k]) => `${c}×${k}`).join(', ')})` : ''}`);
	}

	// хэши без голосов (цвет не упомянут в именах) — посчитать
	const all = new Set<string>();
	for (const p of rows) {
		const prop = p['property358'] as { value?: unknown } | null;
		if (prop?.value != null) all.add(String(prop.value));
	}
	const unknown = [...all].filter((h) => !dict[h]);
	console.log(`\nхэшей всего: ${all.size}, распознано: ${Object.keys(dict).length}, без имени-подсказки: ${unknown.length}`);
	for (const h of unknown.slice(0, 10)) console.log(`  ? ${h}`);
})().catch((e) => console.error('FATAL', e));
