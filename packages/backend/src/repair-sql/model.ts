import { createHash } from 'node:crypto';
import { supplyMirrorCanonicalJson } from '../database/supply-backfill-plan.js';
import type { RepairData, RepairFile, RepairPhoto } from '../routes/repair-record.js';
import { normalizeStatus, statusOrder, type RepairKind, type RepairStatus } from '../routes/repair-status.js';

export interface RepairSqlIssue {
	code: string;
	identity: string;
	message: string;
}

export interface RepairSqlRecord extends RepairData {
	id: number;
	bitrixExternalId: number | null;
	name: string;
	stateHash: string;
}

const TOP_LEVEL_FIELDS = [
	'kind', 'status', 'repairNo', 'client', 'device', 'model', 'serial', 'point', 'appearance', 'defect',
	'payType', 'cost', 'ourPrice', 'dealId', 'taskId', 'clientRefusal', 'repairItemCode', 'repairStore',
	'issueStore', 'repairDeliveryNote', 'productId', 'sourceStore', 'comment', 'internalComment', 'photos',
	'files', 'createdAt', 'createdById', 'createdByName', 'history', 'sqlPublicId',
] as const;

function object(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function addIssue(issues: RepairSqlIssue[], code: string, identity: string, message: string): void {
	issues.push({ code, identity, message });
}

function checkUnknown(value: Record<string, unknown>, allowed: readonly string[], identity: string, issues: RepairSqlIssue[]): void {
	const keys = new Set(allowed);
	for (const key of Object.keys(value)) if (!keys.has(key)) addIssue(issues, 'unknown_field', `${identity}.${key}`, 'Source field has no normalized SQL destination');
}

function text(value: unknown, max: number, identity: string, issues: RepairSqlIssue[]): string {
	const result = String(value ?? '');
	if (result.length > max) addIssue(issues, 'text_too_long', identity, `Text exceeds ${max} characters`);
	return result;
}

function optionalPositiveInteger(value: unknown, identity: string, issues: RepairSqlIssue[]): number | null {
	if (value == null || value === '') return null;
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result <= 0) {
		addIssue(issues, 'invalid_positive_integer', identity, `Expected a positive integer: ${String(value)}`);
		return null;
	}
	return result;
}

function timestamp(value: unknown, identity: string, issues: RepairSqlIssue[], required = false): string {
	const source = String(value ?? '').trim();
	if (!source) {
		if (required) addIssue(issues, 'missing_timestamp', identity, 'Required timestamp is empty');
		return '';
	}
	const parsed = new Date(source);
	if (!Number.isFinite(parsed.getTime())) {
		addIssue(issues, 'invalid_timestamp', identity, `Invalid timestamp: ${source}`);
		return source;
	}
	return parsed.toISOString();
}

function money(value: unknown, identity: string, issues: RepairSqlIssue[]): number | null {
	if (value == null || value === '') return null;
	const result = Number(value);
	if (!Number.isFinite(result) || result < 0) {
		addIssue(issues, 'invalid_money', identity, `Expected non-negative money: ${String(value)}`);
		return null;
	}
	return result;
}

function mediaRows(value: unknown, kind: 'photo' | 'file', identity: string, issues: RepairSqlIssue[]): RepairPhoto[] | RepairFile[] {
	if (!Array.isArray(value)) {
		addIssue(issues, 'invalid_media', identity, `${kind} collection must be an array`);
		return [];
	}
	return value.flatMap((raw, index) => {
		const row = object(raw);
		if (!row) {
			addIssue(issues, 'invalid_media_row', `${identity}:${index}`, 'Media row must be an object');
			return [];
		}
		checkUnknown(row, kind === 'photo' ? ['id', 'name', 'url'] : ['id', 'name', 'url', 'type'], `${identity}:${index}`, issues);
		const url = text(row['url'], 8192, `${identity}:${index}.url`, issues);
		if (!url) addIssue(issues, 'missing_media_url', `${identity}:${index}`, 'Media URL is empty');
		const common = {
			id: Number.isSafeInteger(Number(row['id'])) && Number(row['id']) >= 0 ? Number(row['id']) : 0,
			name: text(row['name'], 500, `${identity}:${index}.name`, issues),
			url,
		};
		return kind === 'photo' ? [common] : [{ ...common, type: text(row['type'], 191, `${identity}:${index}.type`, issues) }];
	});
}

function normalizedRepairData(data: Record<string, unknown>, identity: string, issues: RepairSqlIssue[]): RepairData {
	checkUnknown(data, TOP_LEVEL_FIELDS, identity, issues);
	const kind: RepairKind = data['kind'] === 'presale' ? 'presale' : 'client';
	if (data['kind'] != null && data['kind'] !== 'client' && data['kind'] !== 'presale') addIssue(issues, 'invalid_kind', identity, `Unsupported repair kind: ${String(data['kind'])}`);
	const rawStatus = String(data['status'] ?? '');
	const status = normalizeStatus(rawStatus, kind);
	const legacyStatuses = kind === 'client' ? new Set(['received', 'returned']) : new Set<string>();
	if (!statusOrder(kind).includes(rawStatus as RepairStatus) && !legacyStatuses.has(rawStatus)) addIssue(issues, 'invalid_status', identity, `Unsupported repair status: ${rawStatus}`);
	const repairNo = optionalPositiveInteger(data['repairNo'], `${identity}.repairNo`, issues) ?? 0;

	const rawClient = object(data['client']);
	if (!rawClient) addIssue(issues, 'invalid_client', `${identity}.client`, 'Client must be an object');
	else checkUnknown(rawClient, ['contactId', 'name', 'phone'], `${identity}.client`, issues);
	const client = {
		contactId: optionalPositiveInteger(rawClient?.['contactId'], `${identity}.client.contactId`, issues),
		name: text(rawClient?.['name'], 255, `${identity}.client.name`, issues),
		phone: text(rawClient?.['phone'], 64, `${identity}.client.phone`, issues),
	};

	const payType = data['payType'] === 'paid' ? 'paid' : 'warranty';
	if (data['payType'] !== 'paid' && data['payType'] !== 'warranty') addIssue(issues, 'invalid_pay_type', identity, `Unsupported pay type: ${String(data['payType'])}`);
	const cost = payType === 'paid' ? money(data['cost'], `${identity}.cost`, issues) : null;
	const ourPrice = payType === 'paid' ? money(data['ourPrice'], `${identity}.ourPrice`, issues) : null;

	let clientRefusal: RepairData['clientRefusal'] = null;
	if (data['clientRefusal'] != null) {
		const refusal = object(data['clientRefusal']);
		if (!refusal) addIssue(issues, 'invalid_refusal', `${identity}.clientRefusal`, 'Refusal must be an object');
		else {
			checkUnknown(refusal, ['at', 'reason', 'byId', 'byName', 'dealCancelled', 'taskReframed'], `${identity}.clientRefusal`, issues);
			const reason = text(refusal['reason'], 65535, `${identity}.clientRefusal.reason`, issues);
			if (!reason) addIssue(issues, 'missing_refusal_reason', `${identity}.clientRefusal`, 'Refusal reason is empty');
			clientRefusal = {
				at: timestamp(refusal['at'], `${identity}.clientRefusal.at`, issues, true),
				reason,
				byId: text(refusal['byId'], 191, `${identity}.clientRefusal.byId`, issues),
				byName: text(refusal['byName'], 255, `${identity}.clientRefusal.byName`, issues),
				dealCancelled: Boolean(refusal['dealCancelled']),
				taskReframed: Boolean(refusal['taskReframed']),
			};
		}
	}

	const history: RepairData['history'] = [];
	if (!Array.isArray(data['history'])) addIssue(issues, 'invalid_history', `${identity}.history`, 'History must be an array');
	else for (const [index, raw] of data['history'].entries()) {
		const row = object(raw);
		if (!row) {
			addIssue(issues, 'invalid_history_row', `${identity}.history:${index}`, 'History row must be an object');
			continue;
		}
		checkUnknown(row, ['at', 'status', 'byId', 'byName', 'note'], `${identity}.history:${index}`, issues);
		const rowStatusRaw = String(row['status'] ?? '');
		const rowStatus = normalizeStatus(rowStatusRaw, kind);
		if (!statusOrder(kind).includes(rowStatusRaw as RepairStatus) && !legacyStatuses.has(rowStatusRaw)) addIssue(issues, 'invalid_history_status', `${identity}.history:${index}`, `Unsupported status: ${rowStatusRaw}`);
		history.push({
			at: timestamp(row['at'], `${identity}.history:${index}.at`, issues, true),
			status: rowStatus,
			byId: text(row['byId'], 191, `${identity}.history:${index}.byId`, issues),
			...(row['byName'] ? { byName: text(row['byName'], 255, `${identity}.history:${index}.byName`, issues) } : {}),
			...(row['note'] ? { note: text(row['note'], 65535, `${identity}.history:${index}.note`, issues) } : {}),
		});
	}

	return {
		kind,
		status,
		repairNo,
		client,
		device: text(data['device'], 255, `${identity}.device`, issues),
		model: text(data['model'], 255, `${identity}.model`, issues),
		serial: text(data['serial'], 255, `${identity}.serial`, issues),
		point: text(data['point'], 255, `${identity}.point`, issues),
		appearance: text(data['appearance'], 65535, `${identity}.appearance`, issues),
		defect: text(data['defect'], 65535, `${identity}.defect`, issues),
		payType,
		cost,
		ourPrice,
		dealId: optionalPositiveInteger(data['dealId'], `${identity}.dealId`, issues),
		taskId: optionalPositiveInteger(data['taskId'], `${identity}.taskId`, issues),
		clientRefusal,
		repairItemCode: data['repairItemCode'] ? text(data['repairItemCode'], 191, `${identity}.repairItemCode`, issues) : null,
		repairStore: data['repairStore'] ? text(data['repairStore'], 255, `${identity}.repairStore`, issues) : null,
		issueStore: data['issueStore'] ? text(data['issueStore'], 255, `${identity}.issueStore`, issues) : null,
		repairDeliveryNote: data['repairDeliveryNote'] ? text(data['repairDeliveryNote'], 191, `${identity}.repairDeliveryNote`, issues) : null,
		productId: optionalPositiveInteger(data['productId'], `${identity}.productId`, issues),
		sourceStore: data['sourceStore'] ? text(data['sourceStore'], 255, `${identity}.sourceStore`, issues) : null,
		comment: text(data['comment'], 65535, `${identity}.comment`, issues),
		internalComment: text(data['internalComment'], 65535, `${identity}.internalComment`, issues),
		photos: mediaRows(data['photos'] ?? [], 'photo', `${identity}.photos`, issues) as RepairPhoto[],
		files: mediaRows(data['files'] ?? [], 'file', `${identity}.files`, issues) as RepairFile[],
		createdAt: timestamp(data['createdAt'], `${identity}.createdAt`, issues, true),
		createdById: text(data['createdById'], 191, `${identity}.createdById`, issues),
		createdByName: text(data['createdByName'], 255, `${identity}.createdByName`, issues),
		history,
	};
}

export function repairStateHash(input: { id: number; name: string; data: RepairData }): string {
	return createHash('sha256').update(supplyMirrorCanonicalJson(input)).digest('hex');
}

export function normalizeRepairSqlRecord(input: {
	id: number;
	bitrixExternalId?: number | null;
	name: unknown;
	data: Record<string, unknown>;
}): { record: RepairSqlRecord | null; issues: RepairSqlIssue[] } {
	const issues: RepairSqlIssue[] = [];
	if (!Number.isSafeInteger(input.id) || input.id <= 0) addIssue(issues, 'invalid_public_id', 'repair', `Invalid repair id: ${input.id}`);
	const name = text(input.name, 255, `repair:${input.id}.name`, issues);
	if (!name) addIssue(issues, 'missing_name', `repair:${input.id}`, 'Repair name is empty');
	const data = normalizedRepairData(input.data, `repair:${input.id}`, issues);
	if (issues.length) return { record: null, issues };
	const stateHash = repairStateHash({ id: input.id, name, data });
	return {
		record: {
			id: input.id,
			bitrixExternalId: input.bitrixExternalId ?? null,
			name,
			...data,
			stateHash,
		},
		issues,
	};
}

export function parseRepairBitrixItem(item: Record<string, unknown>): { record: RepairSqlRecord | null; issues: RepairSqlIssue[] } {
	const externalId = Number(item['ID']);
	if (!Number.isSafeInteger(externalId) || externalId <= 0) return { record: null, issues: [{ code: 'invalid_external_id', identity: 'repair', message: `Invalid Bitrix id: ${String(item['ID'])}` }] };
	let data: Record<string, unknown>;
	try {
		data = object(JSON.parse(String(item['DETAIL_TEXT'] ?? '{}'))) ?? {};
	} catch {
		return { record: null, issues: [{ code: 'invalid_json', identity: `repair:${externalId}`, message: 'DETAIL_TEXT is not valid JSON' }] };
	}
	const marker = data['sqlPublicId'];
	const publicId = marker == null ? externalId : Number(marker);
	return normalizeRepairSqlRecord({ id: publicId, bitrixExternalId: externalId, name: item['NAME'], data });
}

export function repairSqlRecordToLegacy(record: RepairSqlRecord): RepairData & { id: number; name: string } {
	const { id, bitrixExternalId: _bitrixExternalId, name, stateHash: _stateHash, ...data } = record;
	return { id, name, ...data };
}
