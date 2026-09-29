/** Posted deliveries net of returns; service profit remains an estimate. */
export interface DealActualProfit {
	documentCount: number;
	goodsRevenue: number;
	worksRevenue: number;
	worksProfitBase: number;
	goodsCost: number | null;
	goodsProfit: number | null;
	missingCostLines: number;
	issues: string[];
}
