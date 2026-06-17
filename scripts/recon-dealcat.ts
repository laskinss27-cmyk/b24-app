/** Read-only: что за воронка (категория) сделок №6 = «Быстрая продажа» + её стадии. */
import 'dotenv/config';
import { B24Client, B24ApiError } from '../packages/backend/src/b24/client.js';
const client = new B24Client({ auth: { kind: 'webhook', url: process.env['DEV_WEBHOOK']! } });
async function call<T>(m: string, p: Record<string, unknown> = {}): Promise<T | null> {
	try { return await client.call<T>(m, p); }
	catch (e) { console.log(`  ⛔ ${m} → ${e instanceof B24ApiError ? `${e.code}: ${e.description ?? ''}` : String(e)}`); return null; }
}
async function main(): Promise<void> {
	console.log('=== все категории сделок ===');
	const list = await call<Array<Record<string, unknown>>>('crm.dealcategory.list', { select: ['ID', 'NAME'] });
	console.log(JSON.stringify(list, null, 1));
	console.log('\n=== категория 6 ===');
	console.log(JSON.stringify(await call('crm.dealcategory.get', { id: 6 }), null, 1));
	console.log('\n=== стадии категории 6 ===');
	console.log(JSON.stringify(await call('crm.dealcategory.stage.list', { id: 6 }), null, 1));
	console.log('\nГОТОВО');
}
main().catch((e) => { console.error(e); process.exit(1); });
