export function formatCatalogNumber(value: number | null | undefined): string {
	return value == null ? '—' : value.toLocaleString('ru-RU');
}

export function productStatuses(status: string | undefined): string[] {
	return String(status ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

export const PRODUCT_STATUS_OPTIONS = [
	'После ремонта', 'Снят с производства', 'Недоступен к заказу', 'К удалению',
	'Уценка', 'Витринный', 'Б/у', 'Распродажа', 'Повреждённый',
	'Некондиция', 'Демо', 'Образец', 'Сток',
] as const;
