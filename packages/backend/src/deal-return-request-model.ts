export const DEAL_RETURN_APPROVER_ID = '1';

export type DealReturnRequestStatus = 'pending' | 'processing' | 'approved' | 'rejected';
export type DealReturnDecision = 'approve' | 'reject';

export interface DealReturnRequestLine {
	productId: number;
	name: string;
	qty: number;
	store: string;
}

export interface DealReturnRequestData {
	dealId: number;
	dealTitle: string;
	lines: DealReturnRequestLine[];
	note: string;
	status: DealReturnRequestStatus;
	createdAt: string;
	createdById: string;
	createdByName: string;
	decidedAt: string;
	decidedById: string;
	decidedByName: string;
	returnDocuments: string[];
	messageId: number | null;
}

export type StoredDealReturnRequest = DealReturnRequestData & { id: number; name: string };

const statuses = new Set<DealReturnRequestStatus>(['pending', 'processing', 'approved', 'rejected']);

export function normalizeDealReturnRequestLines(value: unknown): DealReturnRequestLine[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((raw) => {
		const line = (raw ?? {}) as Record<string, unknown>;
		const productId = Number(line['productId']);
		const qty = Number(line['qty']);
		const store = String(line['store'] ?? '').trim().slice(0, 200);
		if (!Number.isInteger(productId) || productId <= 0 || !Number.isFinite(qty) || qty <= 0 || !store) return [];
		return [{
			productId,
			name: String(line['name'] ?? '').trim().slice(0, 300),
			qty,
			store,
		}];
	});
}

export function parseDealReturnRequestItem(item: Record<string, unknown>): StoredDealReturnRequest | null {
	let data: Partial<DealReturnRequestData>;
	try {
		data = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Partial<DealReturnRequestData> : {};
	} catch {
		return null;
	}
	const id = Number(item['ID'] ?? item['id']);
	const dealId = Number(data.dealId);
	if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(dealId) || dealId <= 0) return null;
	return {
		id,
		name: String(item['NAME'] ?? item['name'] ?? `Заявка на возврат #${id}`),
		dealId,
		dealTitle: String(data.dealTitle ?? '').slice(0, 300),
		lines: normalizeDealReturnRequestLines(data.lines),
		note: String(data.note ?? '').trim().slice(0, 500),
		status: statuses.has(data.status as DealReturnRequestStatus) ? data.status as DealReturnRequestStatus : 'pending',
		createdAt: String(data.createdAt ?? ''),
		createdById: String(data.createdById ?? ''),
		createdByName: String(data.createdByName ?? ''),
		decidedAt: String(data.decidedAt ?? ''),
		decidedById: String(data.decidedById ?? ''),
		decidedByName: String(data.decidedByName ?? ''),
		returnDocuments: Array.isArray(data.returnDocuments) ? data.returnDocuments.map(String).filter(Boolean) : [],
		messageId: Number.isInteger(Number(data.messageId)) && Number(data.messageId) > 0 ? Number(data.messageId) : null,
	};
}

export function newDealReturnRequestData(args: {
	dealId: number;
	dealTitle: string;
	lines: DealReturnRequestLine[];
	note: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
}): DealReturnRequestData {
	return {
		dealId: args.dealId,
		dealTitle: args.dealTitle,
		lines: normalizeDealReturnRequestLines(args.lines),
		note: args.note.trim().slice(0, 500),
		status: 'pending',
		createdAt: args.createdAt,
		createdById: args.createdById,
		createdByName: args.createdByName,
		decidedAt: '',
		decidedById: '',
		decidedByName: '',
		returnDocuments: [],
		messageId: null,
	};
}
