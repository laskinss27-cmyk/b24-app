/** Read-only: справочник ЦВЕТА (property 358) — id/value/xmlId; сверка с хэшами из вариаций. */
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
	const res = await call<{ productPropertyEnums?: Array<Record<string, unknown>> }>('catalog.productPropertyEnum.list', { filter: { propertyId: 358 } });
	console.log('=== справочник property 358 (Цвет) ===');
	for (const e of res?.productPropertyEnums ?? []) console.log(`  id=${e['id']} «${e['value']}» xmlId=${e['xmlId']}`);

	console.log('\n=== property358 у трубок 7500-7512 (сырой вид) ===');
	const prods = await call<{ products?: Array<Record<string, unknown>> }>('catalog.product.list', {
		filter: { iblockId: 26, '>=id': 7500, '<=id': 7512 },
		select: ['id', 'iblockId', 'name', 'property358'],
		order: { id: 'ASC' },
	});
	for (const p of prods?.products ?? []) console.log(`  [${p['id']}] property358=${JSON.stringify(p['property358'])}`);
})().catch((e) => console.error('FATAL', e));
