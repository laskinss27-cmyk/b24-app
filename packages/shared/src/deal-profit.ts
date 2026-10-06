/** Posted deliveries net of returns; service profit remains an estimate. */
export interface DealActualProfit {
	documentCount: number;
	goodsRevenue: number;
	worksRevenue: number;
	worksProfitBase: number;
	/** Historical repair service deliveries; only used when no working plan exists. */
	repairRevenue?: number;
	repairQty?: number;
	goodsCost: number | null;
	goodsProfit: number | null;
	missingCostLines: number;
	issues: string[];
}

/** Prices from the linked paid client repair, never a service coefficient. */
export interface DealRepairProfit {
	clientPrice: number | null;
	serviceCost: number | null;
	profit: number | null;
	status: string;
}
