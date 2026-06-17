/** Read-only: как выглядит ответ catalog.productPropertyEnum.list для property 360. */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
	const { stdout } = await execFileP('curl.exe', [
		'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '60',
		'-H', 'Content-Type: application/json', '-d', JSON.stringify(params), `${WEBHOOK}/${method}.json`,
	], { maxBuffer: 16 * 1024 * 1024 });
	return JSON.parse(stdout);
}

(async () => {
	console.log('1) без фильтра:', JSON.stringify(await call('catalog.productPropertyEnum.list', {}), null, 1).slice(0, 800));
	console.log('\n2) filter propertyId:360:', JSON.stringify(await call('catalog.productPropertyEnum.list', { filter: { propertyId: 360 } }), null, 1).slice(0, 800));
})().catch((e) => console.error('FATAL', e));
