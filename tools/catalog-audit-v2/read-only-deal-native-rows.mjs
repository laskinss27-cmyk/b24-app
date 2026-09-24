import { B24Client } from './packages/backend/dist/b24/client.js';

const dealId = Number(process.argv[2]);
if (!Number.isInteger(dealId) || dealId <= 0) throw new Error('Usage: <dealId>');
const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('B24 webhook is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const [deal, rows, bindings] = await Promise.all([
	b24.call('crm.deal.get', { id: dealId }),
	b24.call('crm.deal.productrows.get', { id: dealId }),
	b24.call('crm.orderentity.list', {
		filter: { ownerId: dealId, ownerTypeId: 2 },
		select: ['orderId', 'ownerId', 'ownerTypeId'],
	}).catch(() => ({ orderEntity: [] })),
]);
const rowDetails = await Promise.all((Array.isArray(rows) ? rows : []).map(async (row) => {
	const id = Number(row.ID);
	const modern = id > 0
		? await b24.call('crm.item.productrow.get', { id }).catch(() => null)
		: null;
	return {
		id,
		productId: Number(row.PRODUCT_ID ?? 0),
		name: String(row.PRODUCT_NAME ?? ''),
		type: Number(row.TYPE ?? 0),
		price: Number(row.PRICE ?? 0),
		quantity: Number(row.QUANTITY ?? 0),
		storeId: row.STORE_ID ?? null,
		reserveId: row.RESERVE_ID ?? null,
		reserveQuantity: Number(row.RESERVE_QUANTITY ?? 0),
		dateReserveEnd: row.DATE_RESERVE_END ?? null,
		modern: modern?.productRow ? {
			ownerType: modern.productRow.ownerType,
			ownerId: modern.productRow.ownerId,
			storeId: modern.productRow.storeId ?? null,
		} : null,
	};
}));
const orderIds = [...new Set((bindings?.orderEntity ?? []).map((item) => Number(item.orderId)).filter((id) => id > 0))];
const orders = await Promise.all(orderIds.map(async (id) => {
	const response = await b24.call('sale.order.get', { id }).catch(() => null);
	const order = response?.order ?? {};
	return {
		id,
		statusId: order.statusId ?? null,
		price: Number(order.price ?? 0),
		payed: order.payed ?? null,
		deducted: order.deducted ?? null,
		basket: (order.basketItems ?? []).map((item) => ({
			id: item.id,
			productId: item.productId,
			name: item.name,
			quantity: Number(item.quantity ?? 0),
			price: Number(item.price ?? 0),
			xmlId: item.xmlId ?? null,
			reservations: item.reservations ?? [],
		})),
	};
}));

process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	deal: {
		id: dealId,
		title: deal.TITLE ?? null,
		categoryId: deal.CATEGORY_ID ?? null,
		stageId: deal.STAGE_ID ?? null,
		stageSemanticId: deal.STAGE_SEMANTIC_ID ?? null,
		closed: deal.CLOSED ?? null,
		opportunity: Number(deal.OPPORTUNITY ?? 0),
		isManualOpportunity: deal.IS_MANUAL_OPPORTUNITY ?? null,
	},
	rows: rowDetails,
	orderBindings: bindings?.orderEntity ?? [],
	orders,
}, null, 2));
