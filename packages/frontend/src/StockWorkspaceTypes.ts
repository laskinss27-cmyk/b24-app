export type StockMovementKind = 'issue' | 'receipt' | 'delivery' | 'return';

export interface StockForm {
	stores: string[];
	suppliers: string[];
	canCreate: boolean;
	canEditSubmitted?: boolean;
	canCreateReceipt?: boolean;
	canCreateIssue?: boolean;
	canPost?: boolean;
	canCancelRealization?: boolean;
}
