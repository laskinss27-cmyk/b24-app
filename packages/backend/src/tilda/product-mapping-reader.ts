import type { TildaProductMapping, TildaMappingStatus, TildaRowKind } from './stock-projection.js';

type QueryRow = Record<string, unknown>;

export interface TildaMappingReadPool {
	query<T>(sql: string, values?: unknown[]): Promise<T>;
}

const MAPPINGS_QUERY = `
	SELECT tilda_uid, tilda_external_id, tilda_sku, tilda_title, row_kind, parent_tilda_uid,
		erp_item_code, mapping_status
	FROM tilda_product_mappings
	WHERE tilda_sku IS NOT NULL
	ORDER BY tilda_external_id
`;

function requiredString(row: QueryRow, field: string): string {
	const value = row[field];
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid SQL Tilda mapping field ${field}`);
	return value.trim();
}

function status(row: QueryRow): TildaMappingStatus {
	const value = requiredString(row, 'mapping_status');
	if (!['confirmed', 'unresolved', 'ignored'].includes(value)) throw new Error(`Invalid SQL Tilda mapping status: ${value}`);
	return value as TildaMappingStatus;
}

function rowKind(row: QueryRow): TildaRowKind {
	const value = requiredString(row, 'row_kind');
	if (!['parent', 'variant'].includes(value)) throw new Error(`Invalid SQL Tilda mapping row kind: ${value}`);
	return value as TildaRowKind;
}

export async function readTildaProductMappings(pool: TildaMappingReadPool): Promise<TildaProductMapping[]> {
	const rows = await pool.query<QueryRow[]>(MAPPINGS_QUERY);
	return rows.map((row) => {
		const mappingStatus = status(row);
		const mappingRowKind = rowKind(row);
		const parentTildaUid = row['parent_tilda_uid'] === null || row['parent_tilda_uid'] === undefined
			? null
			: String(row['parent_tilda_uid']).trim();
		if (mappingRowKind === 'parent' && parentTildaUid) throw new Error('SQL Tilda parent mapping has parent_tilda_uid');
		if (mappingRowKind === 'variant' && !parentTildaUid) throw new Error('SQL Tilda variant mapping has no parent_tilda_uid');
		const itemCode = row['erp_item_code'] === null || row['erp_item_code'] === undefined
			? ''
			: String(row['erp_item_code']).trim();
		const productId = itemCode ? Number(itemCode) : 0;
		if (mappingStatus === 'confirmed' && (!Number.isInteger(productId) || productId <= 0)) {
			throw new Error(`Confirmed SQL Tilda mapping has invalid ERP Item code: ${itemCode}`);
		}
		return {
			productId,
			tildaUid: requiredString(row, 'tilda_uid'),
			externalId: requiredString(row, 'tilda_external_id'),
			sku: requiredString(row, 'tilda_sku'),
			title: requiredString(row, 'tilda_title'),
			status: mappingStatus,
			rowKind: mappingRowKind,
			parentTildaUid,
		};
	});
}
