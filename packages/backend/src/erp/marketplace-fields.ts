import { ErpClient } from './client.js';

export const MARKETPLACE_OPERATION_FIELD = 'b24_marketplace_operation';
export const MARKETPLACE_NAME_FIELD = 'b24_marketplace';
export const MARKETPLACE_TITLE_FIELD = 'b24_marketplace_title';
export const MARKETPLACE_BUNDLE_SOURCE_FIELD = 'b24_bundle_source_product';
export const MARKETPLACE_BUNDLE_UNITS_FIELD = 'b24_bundle_units';
export const MARKETPLACE_OLD_ID_FIELD = 'b24_marketplace_old_id';

let marketplaceFieldsDone = false;
let marketplaceOldIdFieldDone = false;

/** Technical markers keep marketplace documents separate from deal realizations. */
export async function ensureMarketplaceFields(erp: ErpClient): Promise<void> {
	if (marketplaceFieldsDone) return;
	const fields = [
		{ fieldname: MARKETPLACE_OPERATION_FIELD, label: 'Marketplace operation' },
		{ fieldname: MARKETPLACE_NAME_FIELD, label: 'Marketplace' },
		{ fieldname: MARKETPLACE_TITLE_FIELD, label: 'Marketplace title' },
	];
	for (const dt of ['Delivery Note', 'Stock Entry'] as const) {
		for (const field of fields) {
			const name = `${dt}-${field.fieldname}`;
			if (!(await erp.get('Custom Field', name))) {
				await erp.create('Custom Field', {
					dt,
					fieldname: field.fieldname,
					label: field.label,
					fieldtype: 'Data',
					insert_after: dt === 'Stock Entry' ? 'stock_entry_type' : 'posting_time',
					in_standard_filter: 1,
					in_list_view: 1,
				});
			}
		}
	}
	for (const field of [
		{ fieldname: MARKETPLACE_BUNDLE_SOURCE_FIELD, label: 'Bundle source product', fieldtype: 'Data' },
		{ fieldname: MARKETPLACE_BUNDLE_UNITS_FIELD, label: 'Bundle units', fieldtype: 'Int' },
	] as const) {
		const name = `Item-${field.fieldname}`;
		if (!(await erp.get('Custom Field', name))) {
			await erp.create('Custom Field', {
				dt: 'Item',
				fieldname: field.fieldname,
				label: field.label,
				fieldtype: field.fieldtype,
				insert_after: 'description',
				in_standard_filter: 1,
			});
		}
	}
	marketplaceFieldsDone = true;
}

/** Старый ID товара из dom-automation. Поле остаётся пустым до ручной проверки сотрудником маркетплейсов. */
export async function ensureMarketplaceOldIdField(erp: ErpClient): Promise<void> {
	if (marketplaceOldIdFieldDone) return;
	const name = `Item-${MARKETPLACE_OLD_ID_FIELD}`;
	if (!(await erp.get('Custom Field', name))) {
		await erp.create('Custom Field', {
			dt: 'Item',
			fieldname: MARKETPLACE_OLD_ID_FIELD,
			label: 'Старый ID',
			fieldtype: 'Data',
			insert_after: 'description',
			in_standard_filter: 1,
			in_list_view: 0,
		});
	}
	marketplaceOldIdFieldDone = true;
}
