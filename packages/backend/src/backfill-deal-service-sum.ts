import 'dotenv/config';
import { B24Client } from './b24/client.js';
import { backfillDealServiceSumSince, ensureDealServiceSumField } from './deal-service-sum.js';
import { ErpClient } from './erp/client.js';

const fromArg = process.argv.find((arg) => arg.startsWith('--from='));
const from = fromArg?.slice('--from='.length) || '2026-07-20';
if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('ожидается --from=YYYY-MM-DD');

const webhook = String(process.env['DEV_WEBHOOK'] ?? '').trim();
if (!webhook) throw new Error('DEV_WEBHOOK не настроен');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ядро склада не подключено');
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const field = await ensureDealServiceSumField(client);
console.log(`Поле: ${field.created ? 'создано' : 'уже существует'} (#${field.id}, ${field.fieldName})`);

const result = await backfillDealServiceSumSince(client, erp, from, (deal) => {
	if (deal.error) console.error(`#${deal.dealId}: ошибка — ${deal.error}`);
	else if (deal.changed) console.log(`#${deal.dealId}: ${deal.value?.toFixed(2)} RUB`);
});
console.log(`Готово: проверено ${result.checked}, изменено ${result.changed}, ошибок ${result.failed}`);
