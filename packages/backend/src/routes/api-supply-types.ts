import type { StoredTransfer } from '../transfers/model.js';

export interface AuthBody { domain?: string; accessToken?: string }

export interface TransferLine {
	productId: number;
	name: string;
	qty: number;
	rate?: number;
	warehouse?: string;
	requestQty?: number;
}

export type TransferProgress = StoredTransfer;

export interface PurchaseReceiptChild {
	name: string;
	displayTitle?: string;
	status: string;
	docstatus: number;
	purchaseOrder: string;
	lines: TransferLine[];
}

export interface PurchaseChild {
	name: string;
	displayTitle?: string;
	supplier: string;
	status: string;
	supplyStage: string;
	orderedAt: string;
	expectedAt: string;
	total: number;
	lines: TransferLine[];
	receipts: PurchaseReceiptChild[];
}

export interface SupplyDecisionLine {
	productId: number;
	itemName: string;
	qty: number;
	action: 'transfer' | 'purchase';
	fromStore: string;
	supplier: string;
}

export interface CurrentUser { id: string; name: string }
