import { B24Client } from './packages/backend/dist/b24/client.js';
import { buildSalesReport } from './packages/backend/dist/b24/sales-report.js';

const from = String(process.argv[2] ?? '2026-09-01');
const to = String(process.argv[3] ?? '2026-09-16');
const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('B24 webhook is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });
const report = await buildSalesReport(b24, { from, to });
const affected = report.rows.filter((row) => row.goodsNoPurchase > 0);
process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(), from, to,
	deals: report.rows.length,
	affectedDeals: affected.length,
	missingLineOccurrences: affected.reduce((sum, row) => sum + row.goodsNoPurchase, 0),
	byCategory: Object.entries(affected.reduce((out, row) => {
		out[row.category] = (out[row.category] ?? 0) + row.goodsNoPurchase;
		return out;
	}, {})).map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
	byCloseMonth: Object.entries(affected.reduce((out, row) => {
		const month = row.dateClosed.slice(0, 7);
		out[month] = (out[month] ?? 0) + row.goodsNoPurchase;
		return out;
	}, {})).map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)),
	topDeals: affected.slice().sort((a, b) => b.goodsNoPurchase - a.goodsNoPurchase).slice(0, 20).map((row) => ({ dealId: row.dealId, closeDate: row.dateClosed, category: row.category, missing: row.goodsNoPurchase })),
}, null, 2));
