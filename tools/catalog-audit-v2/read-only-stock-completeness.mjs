import { createHash } from 'node:crypto';
import { ErpClient } from '/app/packages/backend/dist/erp/client.js';
import { parseCatalogContent } from '/app/packages/backend/dist/catalog-content.js';

const erp = ErpClient.fromEnv();
if (!erp) throw new Error('ERPNext connection is not configured');

const itemFields = [
	'name', 'item_code', 'item_name', 'item_group', 'is_stock_item', 'disabled', 'modified',
	'b24_article', 'b24_model', 'b24_brand', 'b24_section', 'b24_product_status',
	'b24_catalog_content', 'b24_filter_category', 'b24_filter_attributes',
	'b24_filter_schema_version', 'b24_filter_updated_at', 'description', 'image',
];
const rawItems = await erp.list('Item', itemFields, [
	['item_group', '=', 'Каталог Б24'],
	['disabled', '=', 0],
	['is_stock_item', '=', 1],
], 0, 'name asc');
const bins = await erp.list('Bin', ['item_code', 'warehouse', 'actual_qty', 'reserved_qty'], [], 0, 'item_code asc');

const text = (value) => String(value ?? '').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim();
const technicalDescription = (value) => /^Б24\s+productId=\d+\b(?:\s*\([^)]*\))?\.?$/iu.test(text(value));
const parseFilterPayload = (value) => {
	try {
		const parsed = typeof value === 'string' ? JSON.parse(value) : value;
		return parsed && typeof parsed === 'object' && Array.isArray(parsed.attributes) ? parsed : null;
	} catch {
		return null;
	}
};
const languageStats = (value) => {
	const source = text(value);
	const cyrillicLetters = (source.match(/[а-яё]/giu) ?? []).length;
	const latinLetters = (source.match(/[a-z]/giu) ?? []).length;
	return {
		cyrillicLetters,
		latinLetters,
		mostlyEnglish: source.length >= 40 && latinLetters >= 30 && latinLetters > Math.max(2 * cyrillicLetters, cyrillicLetters + 25),
	};
};
const placeholderPattern = /^(?:-|—|нет данных|неизвестно|n\/?a|unknown|none|null|undefined|tbd)$/iu;

const stockByItem = new Map();
for (const bin of bins) {
	const key = text(bin.item_code);
	const current = stockByItem.get(key) ?? { actual: 0, reserved: 0, warehouses: [] };
	const actual = Number(bin.actual_qty ?? 0);
	const reserved = Number(bin.reserved_qty ?? 0);
	current.actual += Number.isFinite(actual) ? actual : 0;
	current.reserved += Number.isFinite(reserved) ? reserved : 0;
	if (actual !== 0 || reserved !== 0) current.warehouses.push({ warehouse: text(bin.warehouse), actual, reserved });
	stockByItem.set(key, current);
}

const items = rawItems.map((row) => {
	const code = text(row.item_code || row.name);
	const stock = stockByItem.get(code) ?? { actual: 0, reserved: 0, warehouses: [] };
	const content = parseCatalogContent(row.b24_catalog_content);
	const filterPayload = parseFilterPayload(row.b24_filter_attributes);
	const rawDescription = technicalDescription(row.description) ? '' : text(row.description);
	const summaryText = text(content?.summary ?? '');
	const visibleSummary = summaryText || rawDescription;
	const attributes = content?.attributes ?? [];
	const filterable = attributes.filter((attribute) => attribute.filterable);
	const duplicateKeys = [...new Set(attributes.map((attribute) => attribute.key).filter((key, index, all) => all.indexOf(key) !== index))];
	const duplicateLabels = [...new Set(attributes.map((attribute) => attribute.label.toLocaleLowerCase('ru-RU')).filter((label, index, all) => all.indexOf(label) !== index))];
	const placeholderAttributes = attributes.filter((attribute) => placeholderPattern.test(text(attribute.rawValue))).map((attribute) => attribute.label);
	const englishLabels = attributes.filter((attribute) => languageStats(attribute.label).mostlyEnglish).map((attribute) => attribute.label);
	return {
		id: text(row.name),
		code,
		name: text(row.item_name),
		article: text(row.b24_article),
		model: text(row.b24_model),
		brand: text(row.b24_brand),
		section: text(row.b24_section),
		status: text(row.b24_product_status),
		image: text(row.image),
		modified: text(row.modified),
		stockActual: stock.actual,
		stockReserved: stock.reserved,
		stockAvailable: stock.actual - stock.reserved,
		warehouses: stock.warehouses,
		description: rawDescription,
		summaryText,
		visibleSummary,
		descriptionLanguage: languageStats(visibleSummary),
		content: content ?? null,
		filterPayload,
		filterCategory: text(row.b24_filter_category),
		filterSchemaVersion: text(row.b24_filter_schema_version),
		filterUpdatedAt: text(row.b24_filter_updated_at),
		attributeCount: attributes.length,
		filterableCount: filterable.length,
		duplicateKeys,
		duplicateLabels,
		placeholderAttributes,
		englishLabels,
	};
}).filter((item) => item.stockActual > 0);

const groups = new Map();
for (const item of items) {
	const key = item.filterCategory || item.section || '—';
	const list = groups.get(key) ?? [];
	list.push(item);
	groups.set(key, list);
}
const baselines = Object.fromEntries([...groups].map(([key, rows]) => {
	const sorted = rows.map((row) => row.attributeCount).sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	const populated = sorted.filter((count) => count > 0);
	const populatedMedian = populated[Math.floor(populated.length / 2)] ?? 0;
	return [key, { itemCount: rows.length, median, populatedMedian, maximum: sorted.at(-1) ?? 0 }];
}));

const reasonWeights = {
	english_description: 100,
	missing_description: 95,
	missing_structured_content: 90,
	missing_attributes: 90,
	missing_filter_payload: 75,
	missing_filter_category: 70,
	very_short_description: 65,
	category_attribute_outlier: 60,
	missing_brand: 55,
	missing_model: 55,
	missing_section: 55,
	missing_article: 20,
	no_filterable_attributes: 45,
	invalid_filter_payload: 75,
	duplicate_attribute_keys: 50,
	duplicate_attribute_labels: 35,
	placeholder_attribute_values: 35,
	english_attribute_labels: 40,
};

for (const item of items) {
	const reasons = [];
	const baseline = baselines[item.filterCategory || item.section || '—'];
	if (!item.visibleSummary) reasons.push('missing_description');
	else if (item.descriptionLanguage.mostlyEnglish) reasons.push('english_description');
	else if (item.visibleSummary.length < 50 || item.visibleSummary.split(/\s+/u).length < 8) reasons.push('very_short_description');
	if (!item.content) reasons.push('missing_structured_content');
	if (!item.attributeCount) reasons.push('missing_attributes');
	if (!item.filterCategory) reasons.push('missing_filter_category');
	if (!item.filterPayload && text(item.filterCategory)) reasons.push('invalid_filter_payload');
	else if (!item.filterPayload) reasons.push('missing_filter_payload');
	if (item.attributeCount > 0 && item.filterableCount === 0) reasons.push('no_filterable_attributes');
	if (!item.brand) reasons.push('missing_brand');
	if (!item.model) reasons.push('missing_model');
	if (!item.section) reasons.push('missing_section');
	if (!item.article) reasons.push('missing_article');
	if (baseline.itemCount >= 3 && baseline.populatedMedian >= 6 && item.attributeCount > 0
		&& item.attributeCount < Math.max(3, Math.floor(baseline.populatedMedian * 0.5))) reasons.push('category_attribute_outlier');
	if (item.duplicateKeys.length) reasons.push('duplicate_attribute_keys');
	if (item.duplicateLabels.length) reasons.push('duplicate_attribute_labels');
	if (item.placeholderAttributes.length) reasons.push('placeholder_attribute_values');
	if (item.englishLabels.length) reasons.push('english_attribute_labels');
	item.reasons = reasons;
	item.issueScore = reasons.reduce((sum, reason) => sum + reasonWeights[reason], 0);
}

const priority = items.filter((item) => item.reasons.some((reason) => reason !== 'missing_article'))
	.sort((left, right) => right.issueScore - left.issueScore || right.stockActual - left.stockActual || left.section.localeCompare(right.section, 'ru'));
const countReasons = (rows) => Object.fromEntries(Object.entries(rows.flatMap((row) => row.reasons).reduce((out, reason) => {
	out[reason] = (out[reason] ?? 0) + 1;
	return out;
}, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
const stableRows = items.map(({ content, filterPayload, ...item }) => item);
const result = {
	generatedAt: new Date().toISOString(),
	source: 'ERPNext Item + Bin; enabled stock items in Каталог Б24; in stock means sum(Bin.actual_qty) > 0',
	catalogHash: createHash('sha256').update(JSON.stringify(stableRows)).digest('hex'),
	summary: {
		enabledStockCatalogItems: rawItems.length,
		positiveStockItems: items.length,
		insufficientItems: priority.length,
		cleanByAutomatedChecks: items.length - priority.length,
		totalActualQuantity: items.reduce((sum, item) => sum + item.stockActual, 0),
		issueReasons: countReasons(priority),
	},
	baselines,
	priority,
	items,
};
process.stdout.write(JSON.stringify(result));
