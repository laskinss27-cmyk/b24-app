import { readFile } from 'node:fs/promises';

export type TildaMappingStatus = 'confirmed' | 'unresolved' | 'ignored';
export type TildaMappingRowKind = 'parent' | 'variant';

export interface TildaProductMappingSeedRow {
	tildaUid: string;
	tildaExternalId: string;
	tildaSku: string | null;
	tildaTitle: string;
	rowKind: TildaMappingRowKind;
	parentTildaUid: string | null;
	variantLabel: string | null;
	erpItemCode: string | null;
	mappingStatus: TildaMappingStatus;
	auditSource: string;
	sourceSeenAt: string;
	confirmedAt: string | null;
}

const HEADER = [
	'tilda_uid', 'tilda_external_id', 'tilda_sku', 'tilda_title', 'row_kind', 'parent_tilda_uid',
	'variant_label', 'erp_item_code', 'mapping_status', 'audit_source', 'source_seen_at', 'confirmed_at',
] as const;
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/u;

function parseLine(line: string): string[] {
	const fields: string[] = [];
	let current = '';
	let quoted = false;
	for (let index = 0; index < line.length; index += 1) {
		const character = line[index]!;
		if (character === '"') {
			if (quoted && line[index + 1] === '"') {
				current += '"';
				index += 1;
			} else {
				quoted = !quoted;
			}
		} else if (character === ';' && !quoted) {
			fields.push(current);
			current = '';
		} else {
			current += character;
		}
	}
	if (quoted) throw new Error('Unterminated quoted field in Tilda mapping seed');
	fields.push(current);
	return fields;
}

function required(value: string, field: string, rowNumber: number): string {
	const clean = value.trim();
	if (!clean) throw new Error(`Tilda mapping seed row ${rowNumber} has empty ${field}`);
	return clean;
}

function nullable(value: string): string | null {
	const clean = value.trim();
	return clean || null;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, rowNumber: number): T {
	const clean = required(value, field, rowNumber);
	if (!allowed.includes(clean as T)) throw new Error(`Tilda mapping seed row ${rowNumber} has invalid ${field}: ${clean}`);
	return clean as T;
}

function unique(rows: TildaProductMappingSeedRow[], value: (row: TildaProductMappingSeedRow) => string | null, label: string): void {
	const seen = new Set<string>();
	for (const row of rows) {
		const current = value(row);
		if (!current) continue;
		if (seen.has(current)) throw new Error(`Duplicate ${label} in Tilda mapping seed: ${current}`);
		seen.add(current);
	}
}

export function parseTildaProductMappingSeed(csv: string): TildaProductMappingSeedRow[] {
	const lines = csv.replace(/^\uFEFF/u, '').split(/\r?\n/u).filter((line) => line.length > 0);
	if (!lines.length) throw new Error('Empty Tilda mapping seed');
	const header = parseLine(lines[0]!);
	if (header.length !== HEADER.length || header.some((field, index) => field !== HEADER[index])) {
		throw new Error('Unexpected Tilda mapping seed header');
	}

	const rows = lines.slice(1).map((line, index) => {
		const rowNumber = index + 2;
		const fields = parseLine(line);
		if (fields.length !== HEADER.length) throw new Error(`Tilda mapping seed row ${rowNumber} has ${fields.length} fields`);
		const row: TildaProductMappingSeedRow = {
			tildaUid: required(fields[0]!, 'tilda_uid', rowNumber),
			tildaExternalId: required(fields[1]!, 'tilda_external_id', rowNumber),
			tildaSku: nullable(fields[2]!),
			tildaTitle: required(fields[3]!, 'tilda_title', rowNumber),
			rowKind: oneOf(fields[4]!, ['parent', 'variant'], 'row_kind', rowNumber),
			parentTildaUid: nullable(fields[5]!),
			variantLabel: nullable(fields[6]!),
			erpItemCode: nullable(fields[7]!),
			mappingStatus: oneOf(fields[8]!, ['confirmed', 'unresolved', 'ignored'], 'mapping_status', rowNumber),
			auditSource: required(fields[9]!, 'audit_source', rowNumber),
			sourceSeenAt: required(fields[10]!, 'source_seen_at', rowNumber),
			confirmedAt: nullable(fields[11]!),
		};
		if (!DATE_TIME.test(row.sourceSeenAt)) throw new Error(`Tilda mapping seed row ${rowNumber} has invalid source_seen_at`);
		if (row.confirmedAt && !DATE_TIME.test(row.confirmedAt)) throw new Error(`Tilda mapping seed row ${rowNumber} has invalid confirmed_at`);
		if (row.rowKind === 'parent' && row.parentTildaUid) throw new Error(`Tilda mapping seed parent row ${rowNumber} has parent_tilda_uid`);
		if (row.rowKind === 'variant' && !row.parentTildaUid) throw new Error(`Tilda mapping seed variant row ${rowNumber} has no parent_tilda_uid`);
		if (row.mappingStatus === 'confirmed' && (!row.tildaSku || !row.erpItemCode || !row.confirmedAt)) {
			throw new Error(`Confirmed Tilda mapping seed row ${rowNumber} is incomplete`);
		}
		if (row.mappingStatus !== 'confirmed' && row.confirmedAt) {
			throw new Error(`Unconfirmed Tilda mapping seed row ${rowNumber} has confirmed_at`);
		}
		return row;
	});

	unique(rows, (row) => row.tildaUid, 'Tilda UID');
	unique(rows, (row) => row.tildaExternalId, 'Tilda External ID');
	unique(rows, (row) => row.tildaSku, 'Tilda SKU');
	unique(rows.filter((row) => row.mappingStatus === 'confirmed'), (row) => row.erpItemCode, 'confirmed ERP Item code');

	const byUid = new Map(rows.map((row) => [row.tildaUid, row]));
	for (const row of rows) {
		if (!row.parentTildaUid) continue;
		const parent = byUid.get(row.parentTildaUid);
		if (!parent || parent.rowKind !== 'parent') throw new Error(`Tilda variant ${row.tildaUid} references a missing parent`);
	}
	return rows;
}

export async function readTildaProductMappingSeed(path: string): Promise<TildaProductMappingSeedRow[]> {
	return parseTildaProductMappingSeed(await readFile(path, 'utf8'));
}
