// Read-only audit. Run inside the backend environment; emits IDs and financial
// totals only, never raw documents, customer names or authentication data.
import { B24Client } from '../packages/backend/src/b24/client.js';
import { ErpClient } from '../packages/backend/src/erp/client.js';
import { readDealsActualProfit } from '../packages/backend/src/erp/deal-profit.js';

const erp = ErpClient.fromEnv();
const webhook = process.env.DEV_WEBHOOK || process.env.CATALOG_WRITE_WEBHOOK;
if (!erp || !webhook) throw new Error('ERP/B24 environment required');
const client = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const deals: Record<string, unknown>[] = [];
for (let start = 0; ; start += 50) {
	const page = await client.call<Record<string, unknown>[]>('crm.deal.list', {
		filter: { CLOSED: 'Y', '>=CLOSEDATE': '2026-09-01T00:00:00+03:00', '<=CLOSEDATE': '2026-09-30T23:59:59+03:00' },
		select: ['ID', 'STAGE_SEMANTIC_ID'], order: { ID: 'ASC' }, start,
	});
	deals.push(...page);
	if (page.length < 50) break;
}
const profits = await readDealsActualProfit(erp, deals.map(d => Number(d.ID)));
const rows = deals.map(d => ({ dealId: Number(d.ID), status: String(d.STAGE_SEMANTIC_ID), ...profits.get(Number(d.ID))! }));
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }));
