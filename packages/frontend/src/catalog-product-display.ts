export function formatCatalogNumber(value: number | null | undefined): string {
	return value == null ? '—' : value.toLocaleString('ru-RU');
}

/** Короткое имя склада для чипов «остатки по складам». */
export function shortStoreTitle(title: string): string {
	return title.replace(/^Максидом\s*/i, '').replace(/^ул\.\s*/i, '').replace(/,?\s*секция\s*/i, ' с.').trim() || title;
}

export function normalizeStoreTitle(title: string): string {
	return title.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

/** Время сборки базы в HH:MM (для метки свежести/кэша). */
export function catalogGeneratedTime(iso: string): string {
	if (!iso) return '';
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function productStatuses(status: string | undefined): string[] {
	return String(status ?? '').split(',').map((value) => value.trim()).filter(Boolean);
}

export const PRODUCT_STATUS_OPTIONS = [
	'После ремонта', 'Снят с производства', 'Недоступен к заказу', 'К удалению',
	'Уценка', 'Витринный', 'Б/у', 'Распродажа', 'Повреждённый',
	'Некондиция', 'Демо', 'Образец', 'Сток',
] as const;
