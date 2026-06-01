/** Read-only: проверка scope + доступности entity-хранилища. npx tsx scripts/check-entity.ts */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function t(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
	try { return await client.call(method, params); }
	catch (e) { return e instanceof B24ApiError ? `⛔ ${e.code}: ${e.description ?? ''}` : `⛔ ${String(e)}`; }
}

async function main(): Promise<void> {
	console.log('scope:', JSON.stringify(await t('scope')));
	console.log('entity.get:', JSON.stringify(await t('entity.get')));
}
main().catch((e) => { console.error(e); process.exit(1); });
