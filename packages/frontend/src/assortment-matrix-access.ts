/** Навигация снабжения уже закрыта правами; здесь отсекаем только неавторизованный контекст. */
export function canOpenAssortmentMatrix(userId: string | number | undefined): boolean {
	return Boolean(String(userId ?? '').trim());
}
