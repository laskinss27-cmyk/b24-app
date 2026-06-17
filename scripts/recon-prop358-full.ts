/** Read-only: полные настройки свойства 358 (Цвет) — тип/userType/settings (где живут значения). */
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
const PROXY_URL = process.env['LOCAL_PROXY'] ?? 'http://127.0.0.1:10809';
const WEBHOOK = (process.env['DEV_WEBHOOK'] ?? '').replace(/\/$/, '');

(async () => {
	const { stdout } = await execFileP('curl.exe', [
		'-s', '-x', PROXY_URL, '--connect-timeout', '15', '--max-time', '40',
		'-H', 'Content-Type: application/json', '-d', JSON.stringify({ id: 358 }), `${WEBHOOK}/catalog.productProperty.get.json`,
	], { maxBuffer: 4 * 1024 * 1024 });
	console.log(JSON.stringify(JSON.parse(stdout), null, 1).slice(0, 2000));
})().catch((e) => console.error('FATAL', e));
