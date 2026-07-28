import { ErpClient } from './client.js';
import {
	erpContext,
	fetchCoreCatalogItems,
	erpWarehouse,
	listActiveStoreTitles,
	SUPPLY_PURCHASE_ORDER_FIELD,
	SUPPLY_PURCHASE_STAGE_FIELD,
} from './operations.js';

export interface TurnoverLedgerRow {
	itemCode: string;
	date: string;
	qty: number;
	voucherType: string;
	voucherNo: string;
}

export interface TurnoverBalance {
	actual: number;
	reserved: number;
	ordered: number;
	stockValue: number | null;
	valuationQty: number;
}

export interface TurnoverReportRow {
	productId: number;
	name: string;
	article: string;
	brand: string;
	section: string;
	currentQty: number;
	reservedQty: number;
	orderedQty: number;
	availableQty: number;
	openingQty: number;
	closingQty: number;
	averageQty: number;
	receivedQty: number;
	soldQty: number;
	returnedQty: number;
	writtenOffQty: number;
	turns: number | null;
	dailySales: number;
	daysOfStock: number | null;
	averagePurchasePrice: number | null;
	stockValue: number | null;
	lastReceiptDate: string;
	lastSaleDate: string;
	status: 'ending' | 'ordered' | 'normal' | 'excess' | 'no_movement' | 'no_stock';
}

interface BuildRowInput {
	productId: number;
	name: string;
	article: string;
	brand: string;
	section: string;
	balance: TurnoverBalance;
	ledger: TurnoverLedgerRow[];
	stockEntryTypes: ReadonlyMap<string, string>;
	from: string;
	to: string;
	today: string;
	days: number;
}

const round = (value: number, digits = 2): number => {
	const factor = 10 ** digits;
	return Math.round((value + Number.EPSILON) * factor) / factor;
};

function moscowDate(): string {
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
	}).formatToParts(new Date());
	const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? '';
	return `${part('year')}-${part('month')}-${part('day')}`;
}

function statusFor(current: number, available: number, ordered: number, sold: number, daysOfStock: number | null): TurnoverReportRow['status'] {
	if (sold <= 0) return current > 0 ? 'no_movement' : 'no_stock';
	if (available <= 0 || (daysOfStock !== null && daysOfStock < 14)) return ordered > 0 ? 'ordered' : 'ending';
	if (daysOfStock !== null && daysOfStock > 180) return 'excess';
	return 'normal';
}

async function getDocumentsInBatches(erp: ErpClient, doctype: string, names: string[]): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for (let i = 0; i < names.length; i += 10) {
		const docs = await Promise.all(names.slice(i, i + 10).map((name) => erp.get<Record<string, unknown>>(doctype, name)));
		for (const doc of docs) if (doc) out.push(doc);
	}
	return out;
}

/** Чистый расчёт одной строки. Все движения уже суммируются по выбранному складу или по компании. */
export function buildTurnoverRow(input: BuildRowInput): TurnoverReportRow {
	let periodNet = 0;
	let afterPeriodNet = 0;
	let received = 0;
	let deliveryNet = 0;
	let returned = 0;
	let writtenOff = 0;
	let lastReceiptDate = '';
	let lastSaleDate = '';

	for (const movement of input.ledger) {
		if (movement.date > input.today) continue;
		if (movement.date > input.to) {
			afterPeriodNet += movement.qty;
			continue;
		}
		if (movement.date < input.from) continue;
		periodNet += movement.qty;
		if (movement.voucherType === 'Purchase Receipt' && movement.qty > 0) {
			received += movement.qty;
			if (movement.date > lastReceiptDate) lastReceiptDate = movement.date;
		}
		if (movement.voucherType === 'Delivery Note') {
			deliveryNet += movement.qty;
			if (movement.qty > 0) returned += movement.qty;
			if (movement.qty < 0 && movement.date > lastSaleDate) lastSaleDate = movement.date;
		}
		if (
			movement.voucherType === 'Stock Entry'
			&& input.stockEntryTypes.get(movement.voucherNo) === 'Material Issue'
			&& movement.qty < 0
		) {
			writtenOff += -movement.qty;
		}
	}

	const closing = input.balance.actual - afterPeriodNet;
	const opening = closing - periodNet;
	const average = (opening + closing) / 2;
	const sold = Math.max(0, -deliveryNet);
	const dailySales = sold / input.days;
	const turns = average > 0 ? sold / average : null;
	const available = input.balance.actual - input.balance.reserved;
	const daysOfStock = dailySales > 0 ? Math.max(0, available) / dailySales : null;
	const averagePurchasePrice = input.balance.stockValue !== null && input.balance.valuationQty > 0
		? input.balance.stockValue / input.balance.valuationQty
		: null;

	return {
		productId: input.productId,
		name: input.name,
		article: input.article,
		brand: input.brand,
		section: input.section,
		currentQty: round(input.balance.actual),
		reservedQty: round(input.balance.reserved),
		orderedQty: round(input.balance.ordered),
		availableQty: round(available),
		openingQty: round(opening),
		closingQty: round(closing),
		averageQty: round(average),
		receivedQty: round(received),
		soldQty: round(sold),
		returnedQty: round(returned),
		writtenOffQty: round(writtenOff),
		turns: turns === null ? null : round(turns),
		dailySales: round(dailySales, 3),
		daysOfStock: daysOfStock === null ? null : round(daysOfStock),
		averagePurchasePrice: averagePurchasePrice === null ? null : round(averagePurchasePrice),
		stockValue: input.balance.stockValue === null ? null : round(input.balance.stockValue),
		lastReceiptDate,
		lastSaleDate,
		status: statusFor(input.balance.actual, available, input.balance.ordered, sold, daysOfStock),
	};
}

export async function buildTurnoverReport(
	erp: ErpClient,
	params: { from: string; to: string; store?: string },
): Promise<{ rows: TurnoverReportRow[]; generatedAt: string; days: number }> {
	const today = moscowDate();
	const days = Math.floor((Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86400000) + 1;
	const ctx = await erpContext(erp);
	const activeStores = await listActiveStoreTitles(erp);
	if (params.store && !activeStores.includes(params.store)) throw new Error('выбранный склад не найден');
	const warehouses = (params.store ? [params.store] : activeStores).map((store) => erpWarehouse(ctx, store));
	const warehouseFilter: unknown[] = warehouses.length === 1
		? ['warehouse', '=', warehouses[0]]
		: ['warehouse', 'in', warehouses];

	const [catalog, bins, rawLedger, orderedHeaders] = await Promise.all([
		fetchCoreCatalogItems(erp),
		erp.list('Bin', ['item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'ordered_qty', 'stock_value', 'valuation_rate'], [warehouseFilter]),
		erp.list('Stock Ledger Entry',
			['item_code', 'posting_date', 'actual_qty', 'warehouse', 'voucher_type', 'voucher_no'],
			[['posting_date', '>=', params.from], ['posting_date', '<=', today], ['is_cancelled', '=', 0], warehouseFilter],
			0, 'posting_date asc, creation asc'),
		erp.list('Purchase Order', ['name'], [[SUPPLY_PURCHASE_STAGE_FIELD, '=', 'ordered'], ['docstatus', '!=', 2]]),
	]);

	type AggregatedBalance = TurnoverBalance & { valuationComplete: boolean };
	const balances = new Map<number, AggregatedBalance>();
	for (const bin of bins) {
		const productId = Number(bin['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const balance = balances.get(productId) ?? { actual: 0, reserved: 0, ordered: 0, stockValue: 0, valuationQty: 0, valuationComplete: true };
		const qty = Number(bin['actual_qty'] ?? 0);
		balance.actual += qty;
		balance.reserved += Number(bin['reserved_qty'] ?? 0);
		balance.ordered += Number(bin['ordered_qty'] ?? 0);
		if (qty > 0) {
			const storedValue = Number(bin['stock_value'] ?? 0);
			const valuationRate = Number(bin['valuation_rate'] ?? 0);
			const value = storedValue > 0 ? storedValue : valuationRate > 0 ? valuationRate * qty : null;
			balance.valuationQty += qty;
			if (value === null) balance.valuationComplete = false;
			else balance.stockValue = (balance.stockValue ?? 0) + value;
		}
		balances.set(productId, balance);
	}
	for (const balance of balances.values()) {
		if (balance.valuationQty <= 0 || !balance.valuationComplete) balance.stockValue = null;
	}

	const ledgerByProduct = new Map<number, TurnoverLedgerRow[]>();
	const stockEntryNames = new Set<string>();
	for (const raw of rawLedger) {
		const productId = Number(raw['item_code']);
		if (!Number.isInteger(productId) || productId <= 0) continue;
		const row: TurnoverLedgerRow = {
			itemCode: String(raw['item_code'] ?? ''),
			date: String(raw['posting_date'] ?? ''),
			qty: Number(raw['actual_qty'] ?? 0),
			voucherType: String(raw['voucher_type'] ?? ''),
			voucherNo: String(raw['voucher_no'] ?? ''),
		};
		const list = ledgerByProduct.get(productId) ?? [];
		list.push(row);
		ledgerByProduct.set(productId, list);
		if (row.voucherType === 'Stock Entry' && row.voucherNo) stockEntryNames.add(row.voucherNo);
	}

	const stockEntryTypes = new Map<string, string>();
	const names = [...stockEntryNames];
	for (let i = 0; i < names.length; i += 200) {
		const entries = await erp.list('Stock Entry', ['name', 'stock_entry_type'], [['name', 'in', names.slice(i, i + 200)]]);
		for (const entry of entries) stockEntryTypes.set(String(entry['name']), String(entry['stock_entry_type'] ?? ''));
	}

	// Заказы поставщикам в приложении остаются черновиками ERPNext, поэтому нативный
	// Bin.ordered_qty их не видит. Добавляем остаток по заказам со стадией «Заказано».
	// Для отчёта одного склада это значение всё равно общее: склад прихода выбирается при приёмке.
	const orderedNames = orderedHeaders.map((row) => String(row['name'] ?? '')).filter(Boolean);
	if (orderedNames.length) {
		const [orders, receiptHeaders] = await Promise.all([
			getDocumentsInBatches(erp, 'Purchase Order', orderedNames),
			erp.list('Purchase Receipt', ['name', SUPPLY_PURCHASE_ORDER_FIELD], [[SUPPLY_PURCHASE_ORDER_FIELD, 'in', orderedNames], ['docstatus', '=', 1]]),
		]);
		const receiptNames = receiptHeaders.map((row) => String(row['name'] ?? '')).filter(Boolean);
		const receivedByOrderProduct = new Map<string, number>();
		const receipts = await getDocumentsInBatches(erp, 'Purchase Receipt', receiptNames);
		for (const receipt of receipts) {
			const order = String(receipt[SUPPLY_PURCHASE_ORDER_FIELD] ?? '');
			for (const item of Array.isArray(receipt['items']) ? receipt['items'] as Array<Record<string, unknown>> : []) {
				const productId = Number(item['item_code']);
				if (!order || !Number.isInteger(productId) || productId <= 0) continue;
				const key = `${order}:${productId}`;
				receivedByOrderProduct.set(key, (receivedByOrderProduct.get(key) ?? 0) + Number(item['qty'] ?? 0));
			}
		}
		const appOrdered = new Map<number, number>();
		for (const order of orders) {
			const orderName = String(order['name'] ?? '');
			for (const item of Array.isArray(order['items']) ? order['items'] as Array<Record<string, unknown>> : []) {
				const productId = Number(item['item_code']);
				if (!orderName || !Number.isInteger(productId) || productId <= 0) continue;
				const remaining = Math.max(Number(item['qty'] ?? 0) - (receivedByOrderProduct.get(`${orderName}:${productId}`) ?? 0), 0);
				appOrdered.set(productId, (appOrdered.get(productId) ?? 0) + remaining);
			}
		}
		for (const [productId, qty] of appOrdered) {
			const balance = balances.get(productId) ?? { actual: 0, reserved: 0, ordered: 0, stockValue: null, valuationQty: 0, valuationComplete: true };
			balance.ordered = Math.max(balance.ordered, qty);
			balances.set(productId, balance);
		}
	}

	const rows = catalog
		.filter((item) => !item.isService)
		.map((item) => buildTurnoverRow({
			productId: item.productId,
			name: item.name,
			article: item.article,
			brand: item.manufacturer,
			section: item.section,
			balance: balances.get(item.productId) ?? { actual: 0, reserved: 0, ordered: 0, stockValue: null, valuationQty: 0 },
			ledger: ledgerByProduct.get(item.productId) ?? [],
			stockEntryTypes,
			from: params.from,
			to: params.to,
			today,
			days,
		}))
		.sort((a, b) => {
			const rank: Record<TurnoverReportRow['status'], number> = { ending: 0, ordered: 1, excess: 2, no_movement: 3, normal: 4, no_stock: 5 };
			return rank[a.status] - rank[b.status] || b.soldQty - a.soldQty || a.name.localeCompare(b.name, 'ru');
		});

	return { rows, generatedAt: new Date().toISOString(), days };
}
