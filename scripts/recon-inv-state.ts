/** Read-only: состояние точки store16 инвентаризации 19510 (entity ctv_inv) + черновики D/S в Б24. */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const execFileP = promisify(execFile);
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function b24<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const { stdout } = await execFileP('curl.exe', [
		'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
		'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
	], { maxBuffer: 32 * 1024 * 1024 });
	const json = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
	if (json.error) throw new Error(`${json.error}: ${json.error_description ?? ''}`);
	return json.result as T;
}

async function main(): Promise<void> {
	const items = await b24<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: 'ctv_inv' });
	const inv = (items ?? []).find((it) => String(it['ID']) === '19510');
	if (!inv) { console.log('инвентаризация 19510 не найдена; есть:', (items ?? []).map((i) => i['ID']).join(',')); return; }
	const data = JSON.parse(String(inv['DETAIL_TEXT'] ?? '{}')) as { points?: Array<Record<string, unknown>> };
	const pt = (data.points ?? []).find((p) => Number(p['storeId']) === 16);
	console.log('точка store16:', JSON.stringify({
		status: pt?.['status'], erpDoc: pt?.['erpDoc'], documents: pt?.['documents'],
		discrepancies: (pt?.['result'] as { discrepancies?: number })?.discrepancies,
		lines: ((pt?.['result'] as { lines?: unknown[] })?.lines ?? []).length,
	}, null, 1));

	// свежие складские документы Б24 (черновики зеркал, если успели родиться)
	const docs = await b24<{ documents?: Array<Record<string, unknown>> }>('catalog.document.list', {
		filter: { '>dateCreate': '2026-06-12T15:00:00+03:00' },
		select: ['id', 'docType', 'title', 'status', 'dateCreate'],
		order: { id: 'DESC' },
	});
	for (const d of docs?.documents ?? []) {
		console.log(`Б24 док ${d['id']} [${d['docType']}] status=${d['status']} «${String(d['title'] ?? '').slice(0, 70)}» ${d['dateCreate']}`);
	}
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
