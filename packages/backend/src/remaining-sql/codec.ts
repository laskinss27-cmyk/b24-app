import { createHash } from 'node:crypto';
import { column, field, nodes, schemas, type Module, type Node, type Scalar } from './schema.js';
export type Row = Record<string, string | number | boolean | null>;
export type Tables = Record<string, Row[]>;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	// Optional object properties have the same meaning as in the legacy serializer.
	// Undefined array elements and invalid scalar values still fail closed.
	if (object(value)) return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Unsupported source value');
	return JSON.stringify(value);
}
export const contentHash = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function scalar(value: unknown, type: Scalar): string | number | boolean {
	if ((type === 'text' && typeof value === 'string' && value.length <= 4_000_000) || (type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (type === 'boolean' && typeof value === 'boolean')) return value as string | number | boolean;
	if (type === 'detail' && ['string', 'number', 'boolean'].includes(typeof value)) return scalar(value, typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : 'boolean');
	throw new Error('Invalid normalized field type');
}
function put(row: Row, key: string, value: unknown, type: Scalar) {
	const parsed = scalar(value, type);
	if (type !== 'detail') { row[key] = parsed; return; }
	const kind = typeof parsed === 'string' ? 'text' : typeof parsed === 'number' ? 'number' : 'boolean';
	row[`${key}_kind`] = kind;
	for (const name of ['text', 'number', 'boolean']) row[`${key}_${name}`] = name === kind ? parsed : null;
}
function get(row: Row, key: string, type: Scalar): string | number | boolean {
	if (type === 'detail') { const kind = String(row[`${key}_kind`]); if (!['text','number','boolean'].includes(kind)) throw new Error('Invalid SQL detail'); return get(row, `${key}_${kind}`, kind as Scalar); }
	const value = row[key];
	return scalar(type === 'boolean' && (value === 0 || value === 1) ? Boolean(value) : value, type);
}
export function encode(module: Module, value: unknown): Tables {
	const root = schemas[module];
	const tables: Tables = Object.fromEntries(nodes(root).map(node => [node.table, []]));
	function visit(node: Node, source: unknown, parentNo: number) {
		if (node.kind === 'array' ? !Array.isArray(source) : !object(source)) throw new Error('Invalid normalized collection');
		const entries = node.kind === 'array' ? (source as unknown[]).map((v, i) => [String(i), v] as const) : node.kind === 'map' ? Object.entries(source as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, 'en')) : [['', source] as const];
		entries.forEach(([key, item], ordinal) => {
			const list = tables[node.table]!;
			const row: Row = { node_no: list.length, parent_no: parentNo, ordinal_no: ordinal };
			if (node.kind === 'map') { if (!key || key.length > 200 || ['__proto__','constructor','prototype'].includes(key)) throw new Error('Invalid map key'); row['entry_key'] = key; }
			list.push(row);
			if (node.scalar) { put(row, 'scalar_value', item, node.scalar); return; }
			if (!object(item)) throw new Error('Invalid normalized record');
			const allowed = new Set([...Object.keys(node.fields ?? {}), ...Object.keys(node.children ?? {})]);
			if (Object.keys(item).some(key => !allowed.has(key))) throw new Error('Unmapped source field');
			for (const [key, spec] of Object.entries(node.fields ?? {})) {
				const f = field(spec);
				if (item[key] === undefined && f.optional) row[column(key)] = null;
				else put(row, column(key), item[key], f.type);
			}
			for (const [key, child] of Object.entries(node.children ?? {})) {
				const present = item[key] !== undefined;
				if (child.optional) row[`has_${column(key)}`] = present;
				if (present || !child.optional) visit(child, item[key], Number(row['node_no']));
			}
		});
	}
	visit(root, value, 0);
	if (Array.isArray(value) && value.some(object)) {
		const ids = value.map(item => (item as Record<string, unknown>)['id']);
		if (new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Duplicate or missing identity');
	}
	return tables;
}
export function decode(module: Module, tables: Tables): unknown {
	function visit(node: Node, parent: number): unknown {
		const rows = (tables[node.table] ?? []).filter(row => Number(row['parent_no']) === parent).sort((a,b) => Number(a['ordinal_no']) - Number(b['ordinal_no']));
		if (rows.some((row, i) => Number(row['ordinal_no']) !== i)) throw new Error('SQL ordinal gap');
		const values = rows.map(row => {
			if (node.scalar) return get(row, 'scalar_value', node.scalar);
			const value: Record<string, unknown> = {};
			for (const [key, spec] of Object.entries(node.fields ?? {})) {
				const f = field(spec); if (f.optional && row[column(key)] === null) continue;
				value[key] = get(row, column(key), f.type);
			}
			for (const [key, child] of Object.entries(node.children ?? {})) {
				if (child.optional && !row[`has_${column(key)}`]) continue;
				value[key] = visit(child, Number(row['node_no']));
			}
			return value;
		});
		if (node.kind === 'object') { if (values.length !== 1) throw new Error('Missing SQL object'); return values[0]; }
		if (node.kind === 'map') return Object.fromEntries(rows.map((row, i) => [String(row['entry_key']), values[i]]));
		return values;
	}
	const value = visit(schemas[module], 0);
	// Re-encoding catches unknown values, identities, extra/orphan rows and absent-child rows.
	const encoded = encode(module, value);
	for (const node of nodes(schemas[module])) if (encoded[node.table]!.length !== (tables[node.table] ?? []).length) throw new Error('Orphan SQL rows');
	return value;
}
