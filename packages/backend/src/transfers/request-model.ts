import { normalizeTransferLines, type TransferLine } from './model.js';

export type TransferRequestStatus = 'pending' | 'converted' | 'canceled';
export type TransferRequestKind = 'transfer' | 'supply';

export interface SupplyRequestLine {
	productId: number | null;
	name: string;
	qty: number;
	link: string;
	note: string;
}

export interface TransferRequestData {
	kind: TransferRequestKind;
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	supplyLines: SupplyRequestLine[];
	note: string;
	status: TransferRequestStatus;
	createdAt: string;
	createdById: string;
	createdByName: string;
	convertedAt: string;
	convertedById: string;
	convertedByName: string;
	transferId: number | null;
	taskId: number | null;
	canceledAt: string;
	canceledById: string;
	canceledByName: string;
}

export type StoredTransferRequest = TransferRequestData & { id: number; name: string };

const statuses = new Set<TransferRequestStatus>(['pending', 'converted', 'canceled']);
const kinds = new Set<TransferRequestKind>(['transfer', 'supply']);

function normalizeSupplyLines(input: unknown): SupplyRequestLine[] {
	if (!Array.isArray(input)) return [];
	return input.map((raw) => {
		const item = (raw ?? {}) as Record<string, unknown>;
		const productId = Number(item['productId']);
		const qty = Number(item['qty']);
		return {
			productId: Number.isInteger(productId) && productId > 0 ? productId : null,
			name: String(item['name'] ?? '').trim().slice(0, 300),
			qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
			link: String(item['link'] ?? '').trim().slice(0, 500),
			note: String(item['note'] ?? '').trim().slice(0, 500),
		};
	}).filter((line) => line.qty > 0 && (line.name || line.productId));
}

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
	const kind = kinds.has(data.kind as TransferRequestKind) ? data.kind as TransferRequestKind : 'transfer';
	return {
		id,
		name: String(item['NAME'] ?? item['name'] ?? `Заказ на перемещение #${id}`),
		kind,
		fromStore: String(data.fromStore ?? ''),
		toStore: String(data.toStore ?? ''),
		lines: normalizeTransferLines(data.lines).filter((line) => line.qty > 0),
		supplyLines: normalizeSupplyLines(data.supplyLines),
		note: String(data.note ?? ''),
		status,
		createdAt: String(data.createdAt ?? ''),
		createdById: String(data.createdById ?? ''),
		createdByName: String(data.createdByName ?? ''),
		convertedAt: String(data.convertedAt ?? ''),
		convertedById: String(data.convertedById ?? ''),
		convertedByName: String(data.convertedByName ?? ''),
		transferId: Number.isInteger(Number(data.transferId)) && Number(data.transferId) > 0 ? Number(data.transferId) : null,
		taskId: Number.isInteger(Number(data.taskId)) && Number(data.taskId) > 0 ? Number(data.taskId) : null,
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
		kind: 'transfer',
		fromStore: args.fromStore,
		toStore: args.toStore,
		lines: args.lines,
		supplyLines: [],
		note: args.note ?? '',
		status: 'pending',
		createdAt: args.createdAt,
		createdById: args.createdById,
		createdByName: args.createdByName,
		convertedAt: '',
		convertedById: '',
		convertedByName: '',
		transferId: null,
		taskId: null,
		canceledAt: '',
		canceledById: '',
		canceledByName: '',
	};
}

export function newSupplyRequestData(args: {
	toStore: string;
	lines: SupplyRequestLine[];
	note?: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
}): TransferRequestData {
	return {
		kind: 'supply',
		fromStore: '',
		toStore: args.toStore,
		lines: [],
		supplyLines: normalizeSupplyLines(args.lines),
		note: args.note ?? '',
		status: 'pending',
		createdAt: args.createdAt,
		createdById: args.createdById,
		createdByName: args.createdByName,
		convertedAt: '',
		convertedById: '',
		convertedByName: '',
		transferId: null,
		taskId: null,
		canceledAt: '',
		canceledById: '',
		canceledByName: '',
	};
}
