/**
 * Read-only: узнать user ID Сергея для канареечного фича-флага.
 * Проверяем гипотезу «webhook rest/1858 = Сергей» + ищем по фамилии.
 * npx tsx scripts/whoami.ts
 */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) {
	console.error('DEV_WEBHOOK не задан');
	process.exit(1);
}
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

function pick(u: Record<string, unknown> | undefined): unknown {
	if (!u) return null;
	return { ID: u['ID'], NAME: u['NAME'], LAST_NAME: u['LAST_NAME'], EMAIL: u['EMAIL'], ACTIVE: u['ACTIVE'] };
}

async function main(): Promise<void> {
	console.log('=== user.get ID=1858 (владелец dev-webhook) ===');
	const byId = await client.call<Array<Record<string, unknown>>>('user.get', { ID: 1858 });
	console.log(JSON.stringify((byId ?? []).map(pick), null, 2));

	console.log('\n=== user.get LAST_NAME=Ласкин (на случай если 1858 — не он) ===');
	const byName = await client.call<Array<Record<string, unknown>>>('user.get', { FILTER: { LAST_NAME: 'Ласкин' } });
	console.log(JSON.stringify((byName ?? []).map(pick), null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
