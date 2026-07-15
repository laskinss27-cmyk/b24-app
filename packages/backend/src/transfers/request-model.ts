import { normalizeTransferLines, type TransferLine } from './model.js';

export type TransferRequestStatus = 'pending' | 'converted' | 'canceled';

export interface TransferRequestData {
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	note: string;
	status: TransferRequestStatus;
	createdAt: string;
	createdById: string;
	createdByName: string;
	convertedAt: string;
	convertedById: string;
	convertedByName: string;
	transferId: number | null;
	canceledAt: string;
	canceledById: string;
	canceledByName: string;
}

export type StoredTransferRequest = TransferRequestData & { id: number; name: string };

const statuses = new Set<TransferRequestStatus>(['pending', 'converted', 'canceled']);

export function parseTransferRequestItem(item: Record<string, unknown>): StoredTransferRequest | null {
	let data: Partial<TransferRequestData>;
	try {
		data = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Partial<TransferRequestData> : {};
	} catch {
		return null;
	}
	const id = Number(item['ID'] ?? item['id']);
	if (!Number.isInteger(id) || id <= 0) return null;
	const status = statuses.has(data.status as TransferRequestStatus) ? data.status as TransferRequestStatus : 'pending';
	return {
		id,
		name: String(item['NAME'] ?? item['name'] ?? `Заявка на перемещение #${id}`),
		fromStore: String(data.fromStore ?? ''),
		toStore: String(data.toStore ?? ''),
		lines: normalizeTransferLines(data.lines).filter((line) => line.qty > 0),
		note: String(data.note ?? ''),
		status,
		createdAt: String(data.createdAt ?? ''),
		createdById: String(data.createdById ?? ''),
		createdByName: String(data.createdByName ?? ''),
		convertedAt: String(data.convertedAt ?? ''),
		convertedById: String(data.convertedById ?? ''),
		convertedByName: String(data.convertedByName ?? ''),
		transferId: Number.isInteger(Number(data.transferId)) && Number(data.transferId) > 0 ? Number(data.transferId) : null,
		canceledAt: String(data.canceledAt ?? ''),
		canceledById: String(data.canceledById ?? ''),
		canceledByName: String(data.canceledByName ?? ''),
	};
}

export function newTransferRequestData(args: {
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	note?: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
}): TransferRequestData {
	return {
		fromStore: args.fromStore,
		toStore: args.toStore,
		lines: args.lines,
		note: args.note ?? '',
		status: 'pending',
		createdAt: args.createdAt,
		createdById: args.createdById,
		createdByName: args.createdByName,
		convertedAt: '',
		convertedById: '',
		convertedByName: '',
		transferId: null,
		canceledAt: '',
		canceledById: '',
		canceledByName: '',
	};
}
