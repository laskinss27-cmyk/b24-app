/**
 * Старые ID карточек, объединённых с основной карточкой товара.
 *
 * Битрикс24 сохраняет productId в старых строках сделок. Поэтому карточки-дубли
 * можно скрыть из каталога, но входящий старый ID необходимо переводить в
 * действующий ID ядра.
 */
const PRODUCT_ID_ALIASES: Readonly<Record<number, number>> = {
	11404: 12972,
	12460: 19986,
	13336: 19182,
	15626: 13876,
	16680: 16832,
	18138: 18142,
	18140: 18142,
	18164: 18166,
	20458: 20460,
};

export function canonicalProductId(productId: number): number {
	let current = productId;
	const visited = new Set<number>();
	while (PRODUCT_ID_ALIASES[current] !== undefined && !visited.has(current)) {
		visited.add(current);
		current = PRODUCT_ID_ALIASES[current]!;
	}
	return current;
}

export function productAliasEntries(): Array<readonly [number, number]> {
	return Object.entries(PRODUCT_ID_ALIASES)
		.map(([alias, canonical]) => [Number(alias), canonical] as const)
		.sort((left, right) => left[0] - right[0]);
}
