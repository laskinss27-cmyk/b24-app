export interface StockAuthBody {
	domain?: string;
	accessToken?: string;
}

export interface StockReceiptLine {
	productId: number;
	qty: number;
	purchase: number;
	retail: number;
}

export interface StockIssueLine {
	productId: number;
	qty: number;
}
