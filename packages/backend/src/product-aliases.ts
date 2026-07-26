/**
 * Серверное зеркало таблицы из @b24-app/shared.
 *
 * Backend запускается из dist без компиляции workspace-пакета shared, поэтому
 * импорт исходного shared-модуля здесь недопустим в production-контейнере.
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
