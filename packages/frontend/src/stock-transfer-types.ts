export type TransferStatus = 'draft' | 'collected' | 'in_transit' | 'accepted' | 'posted' | 'canceled' | 'requested' | 'received' | 'shortage';

export interface TransferLineDto { productId: number; name: string; qty: number; rate?: number; warehouse?: string; requestQty?: number }

export interface TransferHistoryChangeDto { productId: number; name: string; field: 'planned' | 'collected' | 'accepted' | 'destination'; from: number | string; to: number | string }

export interface TransferHistoryEventDto { at: string; status: TransferStatus; byId: string; byName?: string; action?: string; note?: string; changes?: TransferHistoryChangeDto[] }

export interface TransferDoc {
	id: number;
	name: string;
	supplyRequest: string;
	supplyRequestKey?: string;
	purchaseOrder?: string;
	dealId: string;
	toStore: string;
	fromStore: string;
	status: TransferStatus;
	lines: TransferLineDto[];
	collectedLines: TransferLineDto[];
	shippedLines: TransferLineDto[];
	acceptedLines: TransferLineDto[];
	note?: string;
	taskId: number | null;
	shipEntry: string | null;
	receiveEntry: string | null;
	receivedLines: TransferLineDto[];
	shortageLines: TransferLineDto[];
	shortageReturnEntry: string | null;
	correctionOf?: number | null;
	correctionKind?: 'shortage_return' | 'overage_transfer' | null;
	correctionIds?: number[];
	createdAt: string;
	createdById: string;
	createdByName: string;
	actionWarning?: string;
	/** ФИО ответственного по сделке (дорезолвлено бэкендом). */
	ownerName?: string;
	history: TransferHistoryEventDto[];
}

export type TransferRequestStatus = 'pending' | 'converted' | 'canceled';
export type TransferRequestKind = 'transfer' | 'supply';

export interface SupplyRequestLineDto { productId: number | null; name: string; qty: number; link?: string; note?: string }

export interface TransferRequestDoc {
	id: number;
	name: string;
	kind: TransferRequestKind;
	fromStore: string;
	toStore: string;
	lines: TransferLineDto[];
	supplyLines: SupplyRequestLineDto[];
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
