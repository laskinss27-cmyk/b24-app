const ASSORTMENT_MATRIX_USER_IDS = new Set(['1', '1858']);

/** Матрица заказов доступна Владимиру Дранишникову и Сергею Ласкину. */
export function canOpenAssortmentMatrix(userId: string | number | undefined): boolean {
	return ASSORTMENT_MATRIX_USER_IDS.has(String(userId ?? ''));
}
