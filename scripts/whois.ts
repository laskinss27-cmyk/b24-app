/** Read-only: user-id инициаторов инвентаризации (Бекасов, Драшников). npx tsx scripts/whois.ts */
import 'dotenv/config';
import { B24Client } from '../packages/backend/src/b24/client.js';

const webhook = process.env['DEV_WEBHOOK'];
if (!webhook) { console.error('DEV_WEBHOOK не задан'); process.exit(1); }
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

async function main(): Promise<void> {
	const filters: Array<[string, Record<string, unknown>]> = [
		['Бекасов точно', { LAST_NAME: 'Бекасов' }],
		['фамилия ~рашник', { '%LAST_NAME': 'рашник' }],
		['фамилия ~ашников', { '%LAST_NAME': 'ашников' }],
		['имя Владимир', { NAME: 'Владимир' }],
	];
	for (const [label, FILTER] of filters) {
		const ln = label;
		const u = await client.call<Array<Record<string, unknown>>>('user.get', { FILTER });
		const picked = (u ?? []).map((x) => ({
			ID: x['ID'], NAME: x['NAME'], LAST_NAME: x['LAST_NAME'],
			WORK_POSITION: x['WORK_POSITION'], ACTIVE: x['ACTIVE'], UF_DEPARTMENT: x['UF_DEPARTMENT'],
		}));
		console.log(`\n=== ${ln} ===\n` + JSON.stringify(picked, null, 1));
	}
}
main().catch((e) => { console.error(e); process.exit(1); });
