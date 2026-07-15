export type TransferStatus =
	| 'draft'
	| 'collected'
	| 'in_transit'
	| 'accepted'
	| 'posted'
	| 'canceled'
	// Старые документы остаются читаемыми после перехода на новый процесс.
	| 'requested'
	| 'received'
	| 'shortage';

export interface TransferLine {
	productId: number;
	name: string;
	qty: number;
}

export type TransferHistoryAction =
	| 'created'
	| 'lines_changed'
	| 'destination_changed'
	| 'collected'
	| 'shipped'
	| 'accepted'
	| 'posted'
	| 'canceled'
	| 'notification_sent'
	| 'notification_failed'
	| 'legacy';

export interface TransferHistoryChange {
	productId: number;
	name: string;
	field: 'planned' | 'collected' | 'accepted' | 'destination';
	from: number | string;
	to: number | string;
}

export interface TransferHistoryEvent {
	at: string;
	status: TransferStatus;
	byId: string;
	byName?: string;
	action?: TransferHistoryAction;
	note?: string;
	changes?: TransferHistoryChange[];
}

export interface TransferData {
	supplyRequest: string;
	supplyRequestKey: string;
	purchaseOrder: string;
	dealId: string;
	toStore: string;
	fromStore: string;
	status: TransferStatus;
	/** Итоговое плановое количество. До отправки формирует резерв, после приемки редактируется снабжением перед проводкой. */
	lines: TransferLine[];
	/** Факт сборки на складе отправки. */
	collectedLines: TransferLine[];
	/** Неизменяемый факт количества, ушедшего в транзит. */
	shippedLines: TransferLine[];
	/** Факт приемки на складе назначения. Может быть больше отправленного. */
	acceptedLines: TransferLine[];
	note: string;
	taskId: number | null;
	shipEntry: string | null;
	receiveEntry: string | null;
	/** Поля старого процесса; сохраняются для совместимости и удаления прежних проводок. */
	receivedLines: TransferLine[];
	shortageLines: TransferLine[];
	shortageReturnEntry: string | null;
	/** Исходное перемещение для автоматически созданного корректировочного документа. */
	correctionOf: number | null;
	/** Направление корректировки: возврат недовоза либо прямой перенос излишка. */
	correctionKind: 'shortage_return' | 'overage_transfer' | null;
	/** Связанные корректировочные документы исходного перемещения. */
	correctionIds: number[];
	createdAt: string;
	createdById: string;
	createdByName: string;
	history: TransferHistoryEvent[];
}

export type StoredTransfer = TransferData & { id: number; name: string };

const statuses = new Set<TransferStatus>([
	'draft', 'collected', 'in_transit', 'accepted', 'posted', 'canceled',
	'requested', 'received', 'shortage',
]);

export function normalizeTransferLines(raw: unknown): TransferLine[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((value) => {
			const line = value as Record<string, unknown>;
			return {
				productId: Number(line['productId']),
				name: String(line['name'] ?? ''),
				qty: Number(line['qty']),
			};
		})
		.filter((line) => Number.isInteger(line.productId) && line.productId > 0 && Number.isFinite(line.qty) && line.qty >= 0);
}

export function parseTransferItem(item: Record<string, unknown>): StoredTransfer | null {
	let data: Partial<TransferData>;
	try {
		data = item['DETAIL_TEXT'] ? JSON.parse(String(item['DETAIL_TEXT'])) as Partial<TransferData> : {};
	} catch {
		return null;
	}
	const id = Number(item['ID'] ?? item['id']);
	if (!Number.isInteger(id) || id <= 0) return null;
	const status = statuses.has(data.status as TransferStatus) ? data.status as TransferStatus : 'draft';
	const lines = normalizeTransferLines(data.lines);
	const receivedLines = normalizeTransferLines(data.receivedLines);
	return {
		id,
		name: String(item['NAME'] ?? item['name'] ?? ''),
		supplyRequest: String(data.supplyRequest ?? ''),
		supplyRequestKey: String(data.supplyRequestKey ?? ''),
		purchaseOrder: String(data.purchaseOrder ?? ''),
		dealId: String(data.dealId ?? ''),
		toStore: String(data.toStore ?? ''),
		fromStore: String(data.fromStore ?? ''),
		status,
		lines,
		collectedLines: normalizeTransferLines(data.collectedLines),
		shippedLines: normalizeTransferLines(data.shippedLines).length
			? normalizeTransferLines(data.shippedLines)
			: status === 'in_transit' || status === 'accepted' || status === 'posted' || status === 'received' || status === 'shortage' ? lines : [],
		acceptedLines: normalizeTransferLines(data.acceptedLines).length ? normalizeTransferLines(data.acceptedLines) : receivedLines,
		note: String(data.note ?? ''),
		taskId: typeof data.taskId === 'number' ? data.taskId : null,
		shipEntry: data.shipEntry ? String(data.shipEntry) : null,
		receiveEntry: data.receiveEntry ? String(data.receiveEntry) : null,
		receivedLines,
		shortageLines: normalizeTransferLines(data.shortageLines),
		shortageReturnEntry: data.shortageReturnEntry ? String(data.shortageReturnEntry) : null,
		correctionOf: Number.isInteger(Number(data.correctionOf)) && Number(data.correctionOf) > 0 ? Number(data.correctionOf) : null,
		correctionKind: data.correctionKind === 'shortage_return' || data.correctionKind === 'overage_transfer' ? data.correctionKind : null,
		correctionIds: Array.isArray(data.correctionIds)
			? data.correctionIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
			: [],
		createdAt: String(data.createdAt ?? ''),
		createdById: String(data.createdById ?? ''),
		createdByName: String(data.createdByName ?? ''),
		history: Array.isArray(data.history) ? data.history as TransferHistoryEvent[] : [],
	};
}

export function newTransferData(args: {
	supplyRequest?: string;
	supplyRequestKey?: string;
	purchaseOrder?: string;
	dealId?: string;
	toStore: string;
	fromStore: string;
	lines: TransferLine[];
	note?: string;
	createdAt: string;
	createdById: string;
	createdByName: string;
	historyNote?: string;
}): TransferData {
	return {
		supplyRequest: args.supplyRequest ?? '',
		supplyRequestKey: args.supplyRequestKey ?? '',
		purchaseOrder: args.purchaseOrder ?? '',
		dealId: args.dealId ?? '',
		toStore: args.toStore,
		fromStore: args.fromStore,
		status: 'draft',
		lines: args.lines,
		collectedLines: [],
		shippedLines: [],
		acceptedLines: [],
		note: args.note ?? '',
		taskId: null,
		shipEntry: null,
		receiveEntry: null,
		receivedLines: [],
		shortageLines: [],
		shortageReturnEntry: null,
		correctionOf: null,
		correctionKind: null,
		correctionIds: [],
		createdAt: args.createdAt,
		createdById: args.createdById,
		createdByName: args.createdByName,
		history: [{
			at: args.createdAt,
			status: 'draft',
			byId: args.createdById,
			byName: args.createdByName,
			action: 'created',
			...(args.historyNote ? { note: args.historyNote } : {}),
		}],
	};
}

export function transferLineMap(lines: TransferLine[]): Map<number, TransferLine> {
	return new Map(lines.map((line) => [line.productId, line]));
}

export function sameTransferQuantities(left: TransferLine[], right: TransferLine[]): boolean {
	const a = transferLineMap(left);
	const b = transferLineMap(right);
	const ids = new Set([...a.keys(), ...b.keys()]);
	return [...ids].every((id) => Math.abs((a.get(id)?.qty ?? 0) - (b.get(id)?.qty ?? 0)) < 0.000001);
}
