const EPSILON = 0.000001;

/**
 * У старых строк Material Request поле b24_deal_qty появилось позже самой заявки,
 * поэтому ERPNext возвращает для него 0. Это не означает, что строка сделки была
 * обнулена: до первой синхронизации её исходным количеством считаем текущий план.
 */
export function resolveDealQtyAtSync(storedDealQty: unknown, currentDealQty: number): number {
	const stored = Number(storedDealQty);
	return Number.isFinite(stored) && stored > EPSILON ? stored : currentDealQty;
}

export function quantityFromDealChange(args: {
	requestQty: number;
	dealQtyAtSync: number;
	nextDealQty: number;
	allocatedQty: number;
}): number {
	if (args.allocatedQty + EPSILON >= args.requestQty && Math.abs(args.nextDealQty - args.dealQtyAtSync) > EPSILON) {
		throw new Error('позиция уже полностью распределена; её количество зафиксировано');
	}
	const next = args.requestQty + (args.nextDealQty - args.dealQtyAtSync);
	if (next + EPSILON < args.allocatedQty) {
		throw new Error(`количество нельзя уменьшить ниже уже распределённого (${args.allocatedQty})`);
	}
	return Math.max(args.allocatedQty, next);
}

export function quantityFromSupplyChange(args: {
	dealQty: number;
	requestQty: number;
	nextRequestQty: number;
	allocatedQty: number;
}): number {
	if (args.allocatedQty + EPSILON >= args.requestQty && Math.abs(args.nextRequestQty - args.requestQty) > EPSILON) {
		throw new Error('позиция уже полностью распределена; её количество зафиксировано');
	}
	if (args.nextRequestQty + EPSILON < args.allocatedQty) {
		throw new Error(`количество нельзя уменьшить ниже уже распределённого (${args.allocatedQty})`);
	}
	return args.dealQty + (args.nextRequestQty - args.requestQty);
}

export function assertProductReplaceAllowed(allocatedQty: number): void {
	if (allocatedQty > EPSILON) {
		throw new Error(`товар уже распределён в количестве ${allocatedQty}; замените только необработанный остаток отдельной строкой сделки`);
	}
}
