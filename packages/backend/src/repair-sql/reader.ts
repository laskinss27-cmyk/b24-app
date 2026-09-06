import type { RepairData, RepairFile, RepairPhoto } from '../routes/repair-record.js';
import type { RepairKind, RepairStatus } from '../routes/repair-status.js';
import type { TransferSqlPool } from '../transfers/sql-store.js';
import { repairStateHash, type RepairSqlRecord } from './model.js';

type QueryRow = Record<string, unknown>;

function positiveInteger(value: unknown, name: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

function optionalPositiveInteger(value: unknown, name: string): number | null {
	if (value == null) return null;
	return positiveInteger(value, name);
}

function timestamp(value: unknown, name: string): string {
	if (value == null || String(value).trim() === '') return '';
	const source = String(value).trim();
	const sql = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?$/.exec(source);
	const normalized = sql ? `${sql[1]}T${sql[2]}.${String(sql[3] ?? '').padEnd(3, '0').slice(0, 3)}Z` : source;
	const parsed = value instanceof Date ? value : new Date(normalized);
	if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid ${name}`);
	return parsed.toISOString();
}

function storedHash(value: unknown): string {
	if (!Buffer.isBuffer(value) || value.length !== 32) throw new Error('Invalid stored repair state hash');
	return value.toString('hex');
}

function money(value: unknown, name: string): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${name}`);
	return parsed;
}

export async function readRepairSqlRecords(pool: TransferSqlPool): Promise<RepairSqlRecord[]> {
	const [recordRows, historyRows, mediaRows] = await Promise.all([
		pool.query<QueryRow[]>(`
			SELECT id, bitrix_external_id, display_name, repair_kind, repair_status, repair_no,
				client_contact_id, client_name, client_phone, device, model, serial_no, acceptance_point,
				appearance_text, defect_text, pay_type, service_cost, customer_price, deal_id, task_id,
				DATE_FORMAT(refusal_at, '%Y-%m-%d %H:%i:%s.%f') AS refusal_at,
				refusal_reason, refusal_by_id, refusal_by_name, refusal_deal_cancelled, refusal_task_reframed,
				repair_item_code, repair_store, issue_store, repair_delivery_note, product_id, source_store,
				service_comment, internal_comment,
				DATE_FORMAT(source_created_at, '%Y-%m-%d %H:%i:%s.%f') AS source_created_at,
				created_by_id, created_by_name, last_state_hash
			FROM repair_records
			WHERE deleted_at IS NULL
			ORDER BY id
		`),
		pool.query<QueryRow[]>(`
			SELECT repair_id, ordinal, DATE_FORMAT(happened_at, '%Y-%m-%d %H:%i:%s.%f') AS happened_at,
				repair_status, actor_id, actor_name, note
			FROM repair_history
			WHERE is_present = 1
			ORDER BY repair_id, ordinal
		`),
		pool.query<QueryRow[]>(`
			SELECT repair_id, media_kind, ordinal, bitrix_file_id, display_name, media_url, media_type
			FROM repair_media
			WHERE is_present = 1
			ORDER BY repair_id, media_kind, ordinal
		`),
	]);

	const historyByRepair = new Map<number, RepairData['history']>();
	for (const row of historyRows) {
		const repairId = positiveInteger(row['repair_id'], 'repair history id');
		const history = historyByRepair.get(repairId) ?? [];
		history.push({
			at: timestamp(row['happened_at'], 'repair history timestamp'),
			status: String(row['repair_status']) as RepairStatus,
			byId: String(row['actor_id'] ?? ''),
			...(row['actor_name'] ? { byName: String(row['actor_name']) } : {}),
			...(row['note'] ? { note: String(row['note']) } : {}),
		});
		historyByRepair.set(repairId, history);
	}

	const photosByRepair = new Map<number, RepairPhoto[]>();
	const filesByRepair = new Map<number, RepairFile[]>();
	for (const row of mediaRows) {
		const repairId = positiveInteger(row['repair_id'], 'repair media id');
		const common = {
			id: Number(row['bitrix_file_id'] ?? 0),
			name: String(row['display_name'] ?? ''),
			url: String(row['media_url'] ?? ''),
		};
		if (String(row['media_kind']) === 'photo') {
			const photos = photosByRepair.get(repairId) ?? [];
			photos.push(common);
			photosByRepair.set(repairId, photos);
		} else {
			const files = filesByRepair.get(repairId) ?? [];
			files.push({ ...common, type: String(row['media_type'] ?? '') });
			filesByRepair.set(repairId, files);
		}
	}

	return recordRows.map((row) => {
		const id = positiveInteger(row['id'], 'repair id');
		const kind = String(row['repair_kind']) as RepairKind;
		const payType = String(row['pay_type']) as RepairData['payType'];
		const refusalAt = timestamp(row['refusal_at'], 'repair refusal timestamp');
		const data: RepairData = {
			kind,
			status: String(row['repair_status']) as RepairStatus,
			repairNo: positiveInteger(row['repair_no'], 'repair number'),
			client: {
				contactId: optionalPositiveInteger(row['client_contact_id'], 'repair contact id'),
				name: String(row['client_name'] ?? ''),
				phone: String(row['client_phone'] ?? ''),
			},
			device: String(row['device'] ?? ''),
			model: String(row['model'] ?? ''),
			serial: String(row['serial_no'] ?? ''),
			point: String(row['acceptance_point'] ?? ''),
			appearance: String(row['appearance_text'] ?? ''),
			defect: String(row['defect_text'] ?? ''),
			payType,
			cost: payType === 'paid' ? money(row['service_cost'], 'repair service cost') : null,
			ourPrice: payType === 'paid' ? money(row['customer_price'], 'repair customer price') : null,
			dealId: optionalPositiveInteger(row['deal_id'], 'repair deal id'),
			taskId: optionalPositiveInteger(row['task_id'], 'repair task id'),
			clientRefusal: refusalAt ? {
				at: refusalAt,
				reason: String(row['refusal_reason'] ?? ''),
				byId: String(row['refusal_by_id'] ?? ''),
				byName: String(row['refusal_by_name'] ?? ''),
				dealCancelled: Boolean(row['refusal_deal_cancelled']),
				taskReframed: Boolean(row['refusal_task_reframed']),
			} : null,
			repairItemCode: row['repair_item_code'] == null ? null : String(row['repair_item_code']),
			repairStore: row['repair_store'] == null ? null : String(row['repair_store']),
			issueStore: row['issue_store'] == null ? null : String(row['issue_store']),
			repairDeliveryNote: row['repair_delivery_note'] == null ? null : String(row['repair_delivery_note']),
			productId: optionalPositiveInteger(row['product_id'], 'repair product id'),
			sourceStore: row['source_store'] == null ? null : String(row['source_store']),
			comment: String(row['service_comment'] ?? ''),
			internalComment: String(row['internal_comment'] ?? ''),
			photos: photosByRepair.get(id) ?? [],
			files: filesByRepair.get(id) ?? [],
			createdAt: timestamp(row['source_created_at'], 'repair created timestamp'),
			createdById: String(row['created_by_id'] ?? ''),
			createdByName: String(row['created_by_name'] ?? ''),
			history: historyByRepair.get(id) ?? [],
		};
		const name = String(row['display_name'] ?? '');
		const stateHash = storedHash(row['last_state_hash']);
		if (repairStateHash({ id, name, data }) !== stateHash) throw new Error(`Repair ${id} SQL state hash mismatch`);
		return {
			id,
			bitrixExternalId: optionalPositiveInteger(row['bitrix_external_id'], 'repair Bitrix id'),
			name,
			...data,
			stateHash,
		};
	});
}
