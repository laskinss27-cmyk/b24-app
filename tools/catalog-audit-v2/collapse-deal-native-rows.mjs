import { B24Client } from './packages/backend/dist/b24/client.js';
import { B24_COLLAPSE_SERVICE_PRODUCT_ID, setDealB24CollapsedService } from './packages/backend/dist/deal-service.js';
import { ErpClient } from './packages/backend/dist/erp/client.js';
import { calculateDealPlanTotal, listDealPlan, listDealRealizations } from './packages/backend/dist/erp/operations.js';

const dealId = Number(process.argv[2]);
const apply = process.argv.includes('--apply');
if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('Usage: <dealId> [--apply]');
const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('B24 webhook is not configured');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const [deal, rows, plan, realizations, bindings, total] = await Promise.all([
	b24.call('crm.deal.get', { id: dealId }),
	b24.call('crm.deal.productrows.get', { id: dealId }),
	listDealPlan(erp, dealId),
	listDealRealizations(erp, dealId),
	b24.call('crm.orderentity.list', { filter: { ownerId: dealId, ownerTypeId: 2 }, select: ['orderId'] }).catch(() => ({ orderEntity: [] })),
	calculateDealPlanTotal(erp, dealId),
]);
if (String(deal.CLOSED ?? '').toUpperCase() === 'Y') throw new Error('Deal is already closed');
if (!Array.isArray(rows) || rows.length === 0) throw new Error('Deal has no native rows');
if (rows.length === 1 && Number(rows[0].PRODUCT_ID) === B24_COLLAPSE_SERVICE_PRODUCT_ID) {
	throw new Error('Deal rows are already collapsed');
}
const orders = await Promise.all((bindings?.orderEntity ?? []).map(async (binding) => {
	const id = Number(binding.orderId);
	const response = await b24.call('sale.order.get', { id });
	return { id, payed: response?.order?.payed, deducted: response?.order?.deducted };
}));
if (orders.some((order) => order.payed === 'Y' || order.deducted === 'Y')) {
	throw new Error('A linked native order is paid or deducted; manual review required');
}

const fulfilled = new Map();
for (const document of realizations) {
	if (!document.submitted) continue;
	const sign = document.isReturn ? -1 : 1;
	for (const item of document.items) {
		fulfilled.set(item.productId, (fulfilled.get(item.productId) ?? 0) + sign * item.qty);
	}
}
const missing = plan
	.map((item) => ({ productId: item.productId, required: item.qty, realized: fulfilled.get(item.productId) ?? 0 }))
	.filter((item) => item.realized + 1e-9 < item.required);
if (missing.length) throw new Error(`ERP plan is not fully realized: ${JSON.stringify(missing)}`);

const summary = {
	generatedAt: new Date().toISOString(), dealId, mode: apply ? 'apply' : 'dry-run',
	deal: { title: deal.TITLE, stageId: deal.STAGE_ID, opportunity: Number(deal.OPPORTUNITY ?? 0) },
	total, orders,
	before: rows.map((row) => ({ id: Number(row.ID), productId: Number(row.PRODUCT_ID), name: row.PRODUCT_NAME, quantity: Number(row.QUANTITY), price: Number(row.PRICE), storeId: row.STORE_ID ?? null, reserveId: row.RESERVE_ID ?? null })),
	plan: plan.map((item) => ({ productId: item.productId, name: item.itemName, quantity: item.qty })),
	realizations: realizations.filter((item) => item.submitted).map((item) => ({ name: item.name, isReturn: item.isReturn, items: item.items.map((line) => ({ productId: line.productId, quantity: line.qty })) })),
};
if (!apply) {
	process.stdout.write(JSON.stringify(summary, null, 2));
	process.exit(0);
}

await setDealB24CollapsedService(b24, dealId, total);
const after = await b24.call('crm.deal.productrows.get', { id: dealId });
if (!Array.isArray(after) || after.length !== 1 || Number(after[0].PRODUCT_ID) !== B24_COLLAPSE_SERVICE_PRODUCT_ID) {
	throw new Error('Bitrix rows were not collapsed as expected');
}
summary.after = after.map((row) => ({ id: Number(row.ID), productId: Number(row.PRODUCT_ID), name: row.PRODUCT_NAME, quantity: Number(row.QUANTITY), price: Number(row.PRICE), storeId: row.STORE_ID ?? null, reserveId: row.RESERVE_ID ?? null }));
process.stdout.write(JSON.stringify(summary, null, 2));
