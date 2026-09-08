export type StockMovementKind = 'issue' | 'receipt' | 'delivery' | 'return';

export interface StockForm {
	stores: string[];
	suppliers: string[];
	canCreate: boolean;
	canCancel?: boolean;
}
