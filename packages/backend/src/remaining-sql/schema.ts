/** Explicit domain schemas. No arbitrary JSON/blob payload is stored in SQL. */
export type Scalar = 'text' | 'number' | 'boolean' | 'detail';
export interface Field { type: Scalar; optional?: boolean }
export interface Node {
	table: string; kind: 'array' | 'object' | 'map'; fields?: Record<string, Scalar | Field>;
	children?: Record<string, Node & { optional?: boolean }>; scalar?: Scalar;
}
export const modules = ['matrix', 'reports', 'contracts', 'sequences', 'realizations', 'log'] as const;
export type Module = typeof modules[number];
const actor = (table: string): Node => ({ table, kind: 'object', fields: { id: 'text', name: 'text' } });
export const schemas: Record<Module, Node> = {
	matrix: { table: 'app_matrix_templates', kind: 'array', fields: { id: 'text', name: 'text', from: 'text', to: 'text', salesScope: 'text', createdAt: 'text', updatedAt: 'text' }, children: {
		createdBy: actor('app_matrix_creators'), updatedBy: actor('app_matrix_editors'),
		selectedStores: { table: 'app_matrix_stores', kind: 'array', scalar: 'text' },
		rows: { table: 'app_matrix_rows', kind: 'array', fields: { productId: 'number', category: 'text', segment: 'text', toOrderQty: 'number', comment: 'text' } },
	} },
	reports: { table: 'app_saved_reports', kind: 'array', fields: { id: 'text', name: 'text', createdAt: 'text', updatedAt: 'text' }, children: {
		definition: { table: 'app_report_definitions', kind: 'object', fields: { datasetId: 'text' }, children: {
			columns: { table: 'app_report_columns', kind: 'array', scalar: 'text' },
			groupBy: { table: 'app_report_groups', kind: 'array', scalar: 'text' },
			filters: { table: 'app_report_filters', kind: 'object', fields: { from: 'text', to: 'text', store: { type: 'text', optional: true } }, children: {
				categoryIds: { table: 'app_report_categories', kind: 'array', scalar: 'number', optional: true },
			} },
			sort: { table: 'app_report_sort', kind: 'array', fields: { field: 'text', direction: 'text' } },
		} },
	} },
	contracts: { table: 'app_contract_documents', kind: 'array', fields: {
		id: 'text', dealId: 'number', contractNumber: 'text', templateId: 'text', templateTitle: 'text', companyId: 'number', companyName: 'text', customerName: 'text', contractDate: 'text', contractDateIso: 'text', createdAt: 'text', filename: 'text', vatRate: 'number', total: 'number',
	} },
	sequences: { table: 'app_contract_sequences', kind: 'map', scalar: 'number' },
	realizations: { table: 'app_legacy_realizations', kind: 'array', fields: { id: 'text', name: 'text', dealId: 'number', orderId: 'number', shipmentId: 'number' }, children: {
		stores: { table: 'app_realization_stores', kind: 'map', fields: { storeId: 'number', storeName: 'text' } },
	} },
	log: { table: 'app_operation_events', kind: 'array', fields: { id: 'text', occurredAt: 'text', level: 'text', area: 'text', operation: 'text', outcome: 'text', summary: 'text' }, children: {
		actor: { ...actor('app_operation_actors'), optional: true },
		deal: { table: 'app_operation_deals', kind: 'object', optional: true, fields: { id: 'number', title: { type: 'text', optional: true } } },
		documents: { table: 'app_operation_documents', kind: 'array', scalar: 'text', optional: true },
		details: { table: 'app_operation_details', kind: 'map', scalar: 'detail', optional: true },
	} },
};
export function nodes(root: Node): Node[] { return [root, ...Object.values(root.children ?? {}).flatMap(nodes)]; }
export const column = (key: string): string => `f_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
export function field(value: Scalar | Field): Field { return typeof value === 'string' ? { type: value } : value; }
export function empty(module: Module): unknown { return module === 'sequences' ? {} : []; }

export function domainDdl(root: Node): Array<{ name: string; sql: string }> {
	const result: Array<{ name: string; sql: string }> = [];
	function visit(node: Node, parent?: Node) {
		const columns = ['snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL', 'node_no INT UNSIGNED NOT NULL', 'parent_no INT UNSIGNED NOT NULL', 'ordinal_no INT UNSIGNED NOT NULL'];
		if (node.kind === 'map') columns.push('entry_key VARCHAR(200) COLLATE utf8mb4_bin NOT NULL');
		const scalarColumns = (prefix: string, type: Scalar, optional = false) => {
			if (type === 'detail') {
				columns.push(`${prefix}_kind ENUM('text','number','boolean') NOT NULL`, `${prefix}_text LONGTEXT NULL`, `${prefix}_number DOUBLE NULL`, `${prefix}_boolean BOOLEAN NULL`);
				columns.push(`CHECK ((${prefix}_kind='text' AND ${prefix}_text IS NOT NULL AND ${prefix}_number IS NULL AND ${prefix}_boolean IS NULL) OR (${prefix}_kind='number' AND ${prefix}_text IS NULL AND ${prefix}_number IS NOT NULL AND ${prefix}_boolean IS NULL) OR (${prefix}_kind='boolean' AND ${prefix}_text IS NULL AND ${prefix}_number IS NULL AND ${prefix}_boolean IN (0,1)))`);
			} else columns.push(`${prefix} ${{ text: 'LONGTEXT', number: 'DOUBLE', boolean: 'BOOLEAN' }[type]} ${optional ? 'NULL' : 'NOT NULL'}`);
		};
		if (node.scalar) scalarColumns('scalar_value', node.scalar);
		for (const [key, value] of Object.entries(node.fields ?? {})) { const f = field(value); scalarColumns(column(key), f.type, f.optional); }
		for (const [key, child] of Object.entries(node.children ?? {})) if (child.optional) columns.push(`has_${column(key)} BOOLEAN NOT NULL CHECK (has_${column(key)} IN (0,1))`);
		columns.push('PRIMARY KEY (snapshot_id,node_no)', 'UNIQUE KEY ordered_child (snapshot_id,parent_no,ordinal_no)', 'FOREIGN KEY (snapshot_id) REFERENCES app_state_revisions(id)');
		if (parent) columns.push(`FOREIGN KEY (snapshot_id,parent_no) REFERENCES ${parent.table}(snapshot_id,node_no)`);
		if (node.kind === 'map') columns.push('UNIQUE KEY mapped_child (snapshot_id,parent_no,entry_key)');
		result.push({ name: node.table, sql: `CREATE TABLE ${node.table} (\n  ${columns.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;\n` });
		for (const child of Object.values(node.children ?? {})) visit(child, node);
	}
	visit(root);
	return result;
}
