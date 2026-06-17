/** Read-only: existence-пробы iblock/справочных REST-методов (на случай двери к HL-цветам). */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function probe(method: string, params: Record<string, unknown> = {}): Promise<void> {
	try {
		const { stdout } = await execFileP('curl.exe', [
			'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '40',
			'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
		], { maxBuffer: 8 * 1024 * 1024 });
		const j = JSON.parse(stdout) as { error?: string; error_description?: string; result?: unknown };
		if (j.error) {
			const notFound = /method not found|ERROR_METHOD_NOT_FOUND/i.test(`${j.error} ${j.error_description}`);
			console.log(`  ${notFound ? '⛔ НЕТ' : '🟡 ЕСТЬ, ошибка'} ${method} → ${j.error}: ${(j.error_description ?? '').slice(0, 90)}`);
		} else {
			console.log(`  ✅ ${method} → ${JSON.stringify(j.result).slice(0, 140)}`);
		}
	} catch (e) { console.log(`  ⛔ ${method} → ${String(e).slice(0, 80)}`); }
}

(async () => {
	for (const m of [
		'iblock.element.list', 'iblock.element.get', 'iblock.property.list', 'iblock.list',
		'catalog.property.getfields', 'catalog.productProperty.get',
		'lists.get', 'lists.field.get',
		'userfieldconfig.list',
		'catalog.section.list',
	]) await probe(m, m === 'catalog.productProperty.get' ? { id: 358 } : {});
})().catch((e) => console.error('FATAL', e));
