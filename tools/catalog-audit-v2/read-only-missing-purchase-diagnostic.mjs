import { B24Client } from './packages/backend/dist/b24/client.js';
import { buildProductBase } from './packages/backend/dist/b24/catalog.js';
import { ErpClient } from './packages/backend/dist/erp/client.js';
import { fetchCoreCatalogPrices } from './packages/backend/dist/erp/operations.js';

const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERP connection is not configured');
const webhook = String(process.env.CATALOG_WRITE_WEBHOOK ?? process.env.DEV_WEBHOOK ?? '').replace(/\/$/u, '');
if (!webhook) throw new Error('B24 webhook is not configured');
const b24 = new B24Client({ auth: { kind: 'webhook', url: webhook } });

const [items, rawPrices, bins, metadata, effectiveCorePrices] = await Promise.all([
	erp.list('Item', ['name', 'item_name', 'is_stock_item', 'disabled', 'creation', 'modified', 'valuation_rate', 'b24_section', 'b24_brand', 'description'], [['item_group', '=', 'Каталог Б24']]),
	erp.list('Item Price', ['name', 'item_code', 'price_list', 'price_list_rate', 'creation', 'modified'], [['price_list', '=', 'Standard Buying']]),
	erp.list('Bin', ['item_code', 'actual_qty', 'valuation_rate', 'stock_value']),
	buildProductBase(b24),
	fetchCoreCatalogPrices(erp),
]);

const metadataById = new Map(metadata.rows.map((row) => [row.id, row]));
const stockById = new Map();
for (const bin of bins) {
	const id = Number(bin.item_code);
	const current = stockById.get(id) ?? { qty: 0, value: 0, positiveValuationBins: 0, placeholderBins: 0 };
	current.qty += Number(bin.actual_qty ?? 0);
	current.value += Number(bin.stock_value ?? 0);
	const rate = Number(bin.valuation_rate ?? 0);
	if (rate > 0.011) current.positiveValuationBins++;
	if (rate > 0 && rate <= 0.011) current.placeholderBins++;
	stockById.set(id, current);
}
const rawPricesById = new Map();
for (const row of rawPrices) {
	const id = Number(row.item_code);
	const list = rawPricesById.get(id) ?? [];
	list.push(row);
	rawPricesById.set(id, list);
}

const activeItems = items.filter((item) => Number(item.disabled ?? 0) === 0);
const invalidActiveItems = activeItems.filter((item) => !(Number.isInteger(Number(item.name)) && Number(item.name) > 0));
const activeGoods = activeItems.filter((item) => Number(item.is_stock_item ?? 0) === 1 && Number.isInteger(Number(item.name)) && Number(item.name) > 0);
const activeServices = activeItems.filter((item) => Number(item.is_stock_item ?? 0) === 0);
const rows = activeGoods.map((item) => {
	const id = Number(item.name);
	const core = effectiveCorePrices.get(id)?.purchase;
	const b24Price = metadataById.get(id)?.purchase;
	const effective = core ?? b24Price ?? null;
	const stock = stockById.get(id) ?? { qty: 0, value: 0, positiveValuationBins: 0, placeholderBins: 0 };
	return {
		id,
		name: String(item.item_name ?? ''),
		section: String(item.b24_section ?? '').trim() || '(без раздела)',
		brand: String(item.b24_brand ?? '').trim() || '(без бренда)',
		creation: String(item.creation ?? ''),
		creationDate: String(item.creation ?? '').slice(0, 10),
		valuationRate: Number(item.valuation_rate ?? 0),
		corePrice: core ?? null,
		b24Price: b24Price ?? null,
		effectivePrice: effective,
		hasCorePriceRow: rawPricesById.has(id),
		corePriceRowCount: rawPricesById.get(id)?.length ?? 0,
		stockQty: stock.qty,
		stockValue: stock.value,
		positiveValuationBins: stock.positiveValuationBins,
		placeholderBins: stock.placeholderBins,
		technicalMigrationDescription: /^Б24\s+productId=/iu.test(String(item.description ?? '').trim()),
	};
});
const missing = rows.filter((row) => !(Number(row.effectivePrice) > 0));
const missingIds = missing.map((row) => String(row.id));

async function listForMissing(doctype, fields, extraFilters = []) {
	const out = [];
	for (let i = 0; i < missingIds.length; i += 150) {
		out.push(...await erp.list(doctype, fields, [['item_code', 'in', missingIds.slice(i, i + 150)], ...extraFilters]));
	}
	return out;
}

const [receipts, ledger] = await Promise.all([
	listForMissing('Purchase Receipt Item', ['item_code', 'rate', 'base_rate', 'qty', 'docstatus', 'creation', 'parent'], [['docstatus', '=', 1]]),
	listForMissing('Stock Ledger Entry', ['item_code', 'voucher_type', 'voucher_no', 'actual_qty', 'incoming_rate', 'valuation_rate', 'posting_date', 'creation'], [['is_cancelled', '=', 0]]),
]);

const receiptById = new Map();
for (const row of receipts) {
	const id = Number(row.item_code);
	const rate = Math.max(Number(row.rate ?? 0), Number(row.base_rate ?? 0));
	const current = receiptById.get(id) ?? { count: 0, positive: 0, latestPositiveRate: null, latestDate: '' };
	current.count++;
	if (rate > 0) {
		current.positive++;
		const date = String(row.creation ?? '');
		if (date >= current.latestDate) { current.latestDate = date; current.latestPositiveRate = rate; }
	}
	receiptById.set(id, current);
}
const ledgerById = new Map();
for (const row of ledger) {
	const id = Number(row.item_code);
	const incomingRate = Number(row.incoming_rate ?? 0);
	const valuationRate = Number(row.valuation_rate ?? 0);
	const current = ledgerById.get(id) ?? { entries: 0, openingPlaceholder: false, positiveCostMovement: false, voucherTypes: new Set() };
	current.entries++;
	current.voucherTypes.add(String(row.voucher_type ?? ''));
	if (String(row.voucher_type ?? '') === 'Stock Reconciliation' && Number(row.actual_qty ?? 0) > 0 && incomingRate <= 0.011 && valuationRate <= 0.011) current.openingPlaceholder = true;
	if (incomingRate > 0.011 || valuationRate > 0.011) current.positiveCostMovement = true;
	ledgerById.set(id, current);
}

const counts = (values) => [...values.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
const by = (list, selector) => {
	const result = new Map();
	for (const row of list) { const key = selector(row); result.set(key, (result.get(key) ?? 0) + 1); }
	return counts(result);
};
const sample = missing.slice().sort((a, b) => b.stockQty - a.stockQty).slice(0, 30).map((row) => ({
	id: row.id, name: row.name, section: row.section, creationDate: row.creationDate,
	stockQty: row.stockQty, valuationRate: row.valuationRate, b24Price: row.b24Price, corePrice: row.corePrice,
	receiptPositiveRate: receiptById.get(row.id)?.latestPositiveRate ?? null,
	ledgerEntries: ledgerById.get(row.id)?.entries ?? 0,
}));
const manualPriceReview = missing
	.filter((row) => row.stockQty > 1e-9 && row.positiveValuationBins === 0 && !ledgerById.get(row.id)?.positiveCostMovement)
	.sort((a, b) => b.stockQty - a.stockQty || a.id - b.id)
	.map((row) => ({
		id: row.id,
		name: row.name,
		section: row.section,
		brand: row.brand,
		creationDate: row.creationDate,
		stockQty: row.stockQty,
		stockValue: row.stockValue,
		ledgerEntries: ledgerById.get(row.id)?.entries ?? 0,
	}));

const summary = {
	activeCatalog: activeItems.length,
	activeGoods: activeGoods.length,
	activeServices: activeServices.length,
	invalidNonCatalogCodesExcluded: invalidActiveItems.length,
	missingEffectivePurchase: missing.length,
	withPositiveEffectivePurchase: rows.length - missing.length,
	missingWithStock: missing.filter((row) => row.stockQty > 1e-9).length,
	missingWithoutStock: missing.filter((row) => row.stockQty <= 1e-9).length,
	missingWithPlaceholderItemValuation: missing.filter((row) => row.valuationRate > 0 && row.valuationRate <= 0.011).length,
	missingWithPositiveItemValuation: missing.filter((row) => row.valuationRate > 0.011).length,
	missingWithPositiveBinValuation: missing.filter((row) => row.positiveValuationBins > 0).length,
	missingWithMigrationDescription: missing.filter((row) => row.technicalMigrationDescription).length,
	missingWithSubmittedPurchaseReceiptPrice: missing.filter((row) => (receiptById.get(row.id)?.positive ?? 0) > 0).length,
	missingWithPositiveCostMovement: missing.filter((row) => ledgerById.get(row.id)?.positiveCostMovement).length,
	missingWithOpeningPlaceholder: missing.filter((row) => ledgerById.get(row.id)?.openingPlaceholder).length,
	coreBuyingPriceRows: rawPrices.length,
	goodsWithCoreBuyingPriceRow: rows.filter((row) => row.hasCorePriceRow).length,
	goodsWithoutCoreBuyingPriceRow: rows.filter((row) => !row.hasCorePriceRow).length,
	missingBecauseCoreZeroOverridesPositiveB24: missing.filter((row) => row.corePrice === 0 && Number(row.b24Price) > 0).length,
	missingInBothCoreAndB24: missing.filter((row) => !(Number(row.corePrice) > 0) && !(Number(row.b24Price) > 0)).length,
	positiveFromCoreBuying: rows.filter((row) => Number(row.corePrice) > 0).length,
	positiveFromB24Fallback: rows.filter((row) => !(Number(row.corePrice) > 0) && Number(row.b24Price) > 0).length,
	missingFromInitialMigrationCohort: missing.filter((row) => row.creationDate === '2026-06-11').length,
	initialMigrationCohortSize: rows.filter((row) => row.creationDate === '2026-06-11').length,
	missingFromSupplierImport: missing.filter((row) => row.section.toLowerCase() === 'товары под заказ').length,
	supplierImportCohortSize: rows.filter((row) => row.section.toLowerCase() === 'товары под заказ').length,
	missingFromOtherCohorts: missing.filter((row) => row.creationDate !== '2026-06-11' && row.section.toLowerCase() !== 'товары под заказ').length,
	stockMissingFromInitialMigrationCohort: missing.filter((row) => row.stockQty > 1e-9 && row.creationDate === '2026-06-11').length,
	stockMissingFromSupplierImport: missing.filter((row) => row.stockQty > 1e-9 && row.section.toLowerCase() === 'товары под заказ').length,
	stockMissingFromOtherCohorts: missing.filter((row) => row.stockQty > 1e-9 && row.creationDate !== '2026-06-11' && row.section.toLowerCase() !== 'товары под заказ').length,
};

process.stdout.write(JSON.stringify({
	generatedAt: new Date().toISOString(),
	definition: 'Active stock Item records in ERP group Каталог Б24 whose catalog-effective purchase price is null, zero, or negative; services and disabled items are excluded. Effective price follows production catalog logic: Standard Buying Item Price first, then current Bitrix purchasingPrice fallback.',
	summary,
	missingByCreationDate: by(missing, (row) => row.creationDate),
	missingBySection: by(missing, (row) => row.section).slice(0, 25),
	missingByBrand: by(missing, (row) => row.brand).slice(0, 25),
	stockMissingBySection: by(missing.filter((row) => row.stockQty > 1e-9), (row) => row.section).slice(0, 25),
	missingByEvidence: [
		{ key: 'Есть проведённый приход с ценой', count: summary.missingWithSubmittedPurchaseReceiptPrice },
		{ key: 'Есть складское движение с положительной себестоимостью', count: summary.missingWithPositiveCostMovement },
		{ key: 'Начальный остаток по технической цене 0,01', count: summary.missingWithOpeningPlaceholder },
		{ key: 'Есть текущий остаток', count: summary.missingWithStock },
		{ key: 'Нет текущего остатка', count: summary.missingWithoutStock },
	],
	manualPriceReview,
	sample,
}, null, 2));
