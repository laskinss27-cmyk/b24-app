/**
 * Генератор сниппета для консоли браузера Сергея: по одному представителю на каждый
 * хэш цвета (property358) → JS, который с его сессией откроет страницы вариаций и
 * вытащит выбранный цвет. Вывод сниппета — готовый словарь {хэш: 'Цвет'}.
 * Запуск: npx tsx scripts/gen-color-snippet.ts
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

(async () => {
	// все вариации: id, parentId, хэш цвета
	const rows: Array<{ id: number; parent: number; hash: string }> = [];
	let start: number | undefined = 0;
	while (start !== undefined) {
		const r = await call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
			filter: { iblockId: 26 }, select: ['id', 'iblockId', 'parentId', 'property358'], order: { id: 'ASC' }, start,
		});
		const page = r?.products ?? [];
		for (const p of page) {
			const prop = p['property358'] as { value?: unknown } | null;
			const hash = prop?.value != null ? String(prop.value) : '';
			const parentRaw = p['parentId'] && typeof p['parentId'] === 'object' ? (p['parentId'] as { value?: unknown }).value : p['parentId'];
			const parent = Number(parentRaw ?? 0);
			if (hash && hash !== '0' && parent > 0) rows.push({ id: Number(p['id']), parent, hash });
		}
		start = page.length === 50 ? (start as number) + 50 : undefined;
	}

	// по одному представителю на хэш
	const reps = new Map<string, { id: number; parent: number }>();
	for (const r of rows) if (!reps.has(r.hash)) reps.set(r.hash, { id: r.id, parent: r.parent });
	console.log(`хэшей: ${reps.size}\n`);

	const list = [...reps.entries()].map(([hash, r]) => `['${hash}',${r.parent},${r.id}]`).join(',');
	console.log('===== СНИППЕТ ДЛЯ КОНСОЛИ (вставить на любой странице портала) =====\n');
	console.log(`(async () => {
  const reps = [${list}];
  const dict = {};
  for (const [hash, parent, vid] of reps) {
    try {
      const html = await (await fetch('/shop/documents-catalog/24/product/' + parent + '/variation/' + vid + '/', { credentials: 'include' })).text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const sel = doc.querySelector('label.ui-ctl-radio-selector.selected[data-property-id="358"]');
      dict[hash] = sel ? sel.getAttribute('title') : '???';
      console.log(hash, '→', dict[hash]);
    } catch (e) { dict[hash] = 'ERR'; console.log(hash, 'ERR', e); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('===== СЛОВАРЬ ГОТОВ, СКОПИРУЙ НИЖЕ =====');
  console.log(JSON.stringify(dict, null, 1));
})();`);
})().catch((e) => console.error('FATAL', e));
