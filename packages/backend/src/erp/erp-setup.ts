import type { ErpClient } from './client.js';

export const DEAL_FIELD = 'b24_deal_id';
export const TECH_CUSTOMER = 'Б24 Розница';
export const TECH_SUPPLIER = 'Б24 Снабжение';

/** Единица измерения по умолчанию (как в миграции каталога). */
export const UOM = 'шт';

/** Документы, которым нужно поле сделки. */
const DEAL_DOCTYPES = ['Delivery Note', 'Stock Entry', 'Purchase Receipt'] as const;

let setupDone = false;

/** Идемпотентная настройка: custom-поля b24_deal_id + технические контрагенты. Раз на процесс. */
export async function ensureErpSetup(erp: ErpClient): Promise<void> {
	if (setupDone) return;
	for (const dt of DEAL_DOCTYPES) {
		const cfName = `${dt}-${DEAL_FIELD}`;
		if (!(await erp.get('Custom Field', cfName))) {
			await erp.create('Custom Field', {
				dt, fieldname: DEAL_FIELD, label: 'B24 Deal', fieldtype: 'Data',
				insert_after: 'posting_time', in_standard_filter: 1, in_list_view: 1,
			});
		}
	}
	if (!(await erp.get('Customer', TECH_CUSTOMER))) {
		await erp.create('Customer', { customer_name: TECH_CUSTOMER, customer_type: 'Individual' });
	}
	if (!(await erp.get('Supplier', TECH_SUPPLIER))) {
		await erp.create('Supplier', { supplier_name: TECH_SUPPLIER, supplier_type: 'Company' });
	}
	setupDone = true;
}
