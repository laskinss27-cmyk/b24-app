/**
 * Позиции, которые должны проводиться как услуги, даже если историческая
 * карточка каталога ошибочно заведена складским товаром.
 *
 * 18816 уже имеет складские движения в ERPNext, поэтому менять глобальный
 * is_stock_item небезопасно. Исключение ограничено составом и реализацией
 * сделки: склад у строки не запрашивается и остаток не списывается.
 */
const DEAL_SERVICE_PRODUCT_IDS = new Set([
	9814001, // виртуальная услуга «Выезд инженера»
	18816, // «Консультация по настройке/монтажу системы видеонаблюдения»
]);

/**
 * У этих позиций исходную Item нельзя переводить в нескладскую: по ней уже есть
 * проведённые складские движения. В Delivery Note используется отдельная
 * нескладская Item, а наружу код всегда преобразуется обратно в productId Б24.
 */
const DEAL_SERVICE_ALIAS_PRODUCT_IDS = new Set([
	18816,
]);

const DEAL_SERVICE_ALIAS_PREFIX = 'B24-SERVICE-';

export function isDealServiceProductId(productId: number): boolean {
	return DEAL_SERVICE_PRODUCT_IDS.has(productId);
}

export function dealServiceAliasItemCode(productId: number): string | null {
	return DEAL_SERVICE_ALIAS_PRODUCT_IDS.has(productId)
		? `${DEAL_SERVICE_ALIAS_PREFIX}${productId}`
		: null;
}

/** Преобразует обычный или служебный Item Code реализации в productId каталога Б24. */
export function dealProductIdFromCoreItemCode(itemCode: unknown): number | null {
	const raw = String(itemCode ?? '').trim();
	const numeric = Number(raw);
	if (Number.isInteger(numeric) && numeric > 0) return numeric;
	if (!raw.startsWith(DEAL_SERVICE_ALIAS_PREFIX)) return null;
	const productId = Number(raw.slice(DEAL_SERVICE_ALIAS_PREFIX.length));
	return Number.isInteger(productId) && DEAL_SERVICE_ALIAS_PRODUCT_IDS.has(productId)
		? productId
		: null;
}
