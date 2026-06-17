/** Read-only: ищем свойство «Цвет» у вариаций (iblock 26): перечень свойств + значения у трубок. */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
	const { stdout } = await execFileP('curl.exe', [
		'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
		'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
	], { maxBuffer: 32 * 1024 * 1024 });
	const j = JSON.parse(stdout) as { result?: T; error?: string; error_description?: string };
	if (j.error) throw new Error(`${j.error}: ${j.error_description ?? ''}`);
	return j.result as T;
}

(async () => {
	console.log('=== свойства каталога (все, без фильтра) ===');
	const props = await call<{ properties?: Array<Record<string, unknown>> }>('catalog.productProperty.list', {});
	for (const p of props?.properties ?? []) {
		console.log(`  property${p['id']} (iblock ${p['iblockId']}): «${p['name']}» type=${p['propertyType']}${p['multiple'] === 'Y' ? ' multi' : ''}`);
	}

	console.log('\n=== трубки 7500-7510: все property-поля явным select ===');
	const ids = (props?.properties ?? []).map((p) => `property${p['id']}`);
	const res = await call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		filter: { iblockId: 26, '>=id': 7500, '<=id': 7512 },
		select: ['id', 'iblockId', 'name', ...ids],
		order: { id: 'ASC' },
	});
	for (const r of res?.products ?? []) {
		const fields = Object.entries(r)
			.filter(([k, v]) => k.startsWith('property') && v != null)
			.map(([k, v]) => `${k}=${JSON.stringify(v && typeof v === 'object' && 'value' in (v as object) ? (v as { value: unknown }).value : v)}`)
			.join(' ');
		console.log(`  [${r['id']}] ${fields}`);
	}
})().catch((e) => console.error('FATAL', e));
