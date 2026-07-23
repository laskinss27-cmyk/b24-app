import 'dotenv/config';
import { B24Client } from './b24/client.js';
import { backfillDealFulfillmentSince, ensureDealFulfillmentField } from './deal-fulfillment.js';
import { ErpClient } from './erp/client.js';

const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
const from = fromArg?.slice('--from='.length) || '2026-07-20';
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('ожидается --from=YYYY-MM-DD');

const webhook = String(process.env['DEV_WEBHOOK'] ?? '').trim();
if (!webhook) throw new Error('DEV_WEBHOOK не настроен');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ядро склада не подключено');
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const field = await ensureDealFulfillmentField(client);
console.log(`Поле: ${field.created ? 'создано' : 'уже существует'} (#${field.id})`);

const result = await backfillDealFulfillmentSince(client, erp, from, (deal) => {
	if (deal.error) console.error(`#${deal.dealId}: ошибка — ${deal.error}`);
	else console.log(`#${deal.dealId}: ${deal.value}${deal.changed ? ' (обновлено)' : ''}`);
});
console.log(`Итого с ${from}: проверено ${result.checked}, обновлено ${result.changed}, ошибок ${result.failed}`);
if (result.failed) process.exitCode = 1;
