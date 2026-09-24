import { B24Client } from './packages/backend/dist/b24/client.js';
import { ErpClient } from './packages/backend/dist/erp/client.js';
import { listDealPlan, listDealStages, listDealRealizations, fetchErpPurchasing } from './packages/backend/dist/erp/operations.js';

const dealId = Number(process.argv[2]);
if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('Usage: <dealId>');
const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('B24 webhook is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const [plan, stages, realizations, coefRaw, b24Rows, deals, deliveryNotes] = await Promise.all([
	listDealPlan(erp, dealId),
	listDealStages(erp, dealId),
	listDealRealizations(erp, dealId),
	b24.call('app.option.get', {}).catch(() => ({})),
	b24.call('crm.deal.productrows.get', { id: dealId }).catch(() => []),
	b24.call('crm.deal.get', { id: dealId }).catch(() => ({})),
	erp.list('Delivery Note', ['name', 'posting_date', 'docstatus', 'is_return', 'return_against', 'grand_total'], [['b24_deal_id', '=', String(dealId)]], 0, 'posting_date asc'),
]);
const coefValue = Number(coefRaw?.profit_coef);
const coef = Number.isFinite(coefValue) && coefValue > 0 ? coefValue : 0.5;
const ids = plan.filter((row) => !row.isService).map((row) => row.productId);
const purchasing = await fetchErpPurchasing(erp, ids);
const itemRows = ids.length ? await erp.list('Item', ['name', 'item_name', 'valuation_rate'], [['name', 'in', ids.map(String)]], 0) : [];
const buyingRows = ids.length ? await erp.list('Item Price', ['name', 'item_code', 'price_list', 'price_list_rate', 'valid_from', 'modified'], [['item_code', 'in', ids.map(String)], ['price_list', '=', 'Standard Buying']], 0) : [];
const itemById = new Map(itemRows.map((row) => [Number(row.name), row]));
const buyingById = new Map(buyingRows.map((row) => [Number(row.item_code), row]));
const planRows = plan.map((row) => {
	const sale = row.priceListRate * (1 - row.discountPercent / 100);
	const purchase = purchasing.get(row.productId) ?? 0;
	const item = itemById.get(row.productId) ?? {};
	const priceRow = buyingById.get(row.productId);
	return {
		productId: row.productId, name: row.itemName, isService: row.isService,
		qty: row.qty, saleUnit: sale, saleTotal: sale * row.qty,
		purchaseUnitUsed: row.isService ? null : purchase,
		purchaseTotalUsed: row.isService ? null : purchase * row.qty,
		goodsProfit: row.isService ? null : (sale - purchase) * row.qty,
		valuationRate: Number(item.valuation_rate ?? 0),
		buyingPrice: priceRow ? Number(priceRow.price_list_rate ?? 0) : null,
		buyingPriceModified: priceRow?.modified ?? null,
	};
});
const goods = planRows.filter((row) => !row.isService);
const works = planRows.filter((row) => row.isService);
const goodsSum = goods.reduce((sum, row) => sum + row.saleTotal, 0);
const worksSum = works.reduce((sum, row) => sum + row.saleTotal, 0);
const goodsCost = goods.reduce((sum, row) => sum + Number(row.purchaseTotalUsed ?? 0), 0);
const goodsProfit = goodsSum - goodsCost;
const worksProfit = worksSum * coef;

const deliveryNoteDetails = [];
for (const summary of deliveryNotes) {
	const doc = await erp.get('Delivery Note', String(summary.name));
	deliveryNoteDetails.push({
		...summary,
		items: (Array.isArray(doc?.items) ? doc.items : []).map((row) => ({
			itemCode: row.item_code, itemName: row.item_name, qty: Number(row.qty ?? 0),
			saleRate: Number(row.rate ?? 0), amount: Number(row.amount ?? 0),
			valuationRate: Number(row.valuation_rate ?? 0), incomingRate: Number(row.incoming_rate ?? 0),
			stockValueDifference: Number(row.stock_value_difference ?? 0), warehouse: row.warehouse,
		})),
	});
}

process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(), dealId,
	deal: { title: deals?.TITLE ?? null, opportunity: Number(deals?.OPPORTUNITY ?? 0), stageId: deals?.STAGE_ID ?? null },
	coef, summary: { goodsSum, worksSum, goodsCost, goodsProfit, worksProfit, profitability: goodsProfit + worksProfit },
	planRows, stages, realizations, deliveryNotes: deliveryNoteDetails,
	b24Rows: Array.isArray(b24Rows) ? b24Rows.map((row) => ({ id: row.ID, productId: row.PRODUCT_ID, name: row.PRODUCT_NAME, type: Number(row.TYPE ?? 0), price: Number(row.PRICE ?? 0), quantity: Number(row.QUANTITY ?? 0), discountSum: Number(row.DISCOUNT_SUM ?? 0) })) : [],
}, null, 2));
