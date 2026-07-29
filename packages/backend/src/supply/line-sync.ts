const EPSILON = 0.000001;

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
