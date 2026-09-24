/** Conditions belong to quantities; lifecycle flags remain on the Item. */
export const STOCK_CONDITIONS = ['Обычный', 'Сток', 'После ремонта', 'Уценка', 'Витринный', 'Б/у', 'Повреждённый', 'Некондиция', 'Демо', 'Образец', 'Распродажа'] as const;
export type StockCondition = typeof STOCK_CONDITIONS[number];
export const CONDITION_SEPARATOR = ' · Состояние: ';
export function isStockCondition(value: unknown): value is StockCondition {
	return typeof value === 'string' && (STOCK_CONDITIONS as readonly string[]).includes(value);
}
export function splitConditionStore(title: string): { store: string; condition: StockCondition } {
	const index = title.lastIndexOf(CONDITION_SEPARATOR);
	const condition = title.slice(index + CONDITION_SEPARATOR.length);
	return index > 0 && isStockCondition(condition) && condition !== 'Обычный'
		? { store: title.slice(0, index), condition } : { store: title, condition: 'Обычный' };
}
export function conditionStoreTitle(store: string, condition: StockCondition): string {
	if (!store.trim() || splitConditionStore(store).condition !== 'Обычный' || !isStockCondition(condition)) throw new Error('Неверный склад или состояние');
	return condition === 'Обычный' ? store.trim() : `${store.trim()}${CONDITION_SEPARATOR}${condition}`;
}
export function stockChoiceLabel(title: string, qty: number): string {
	const {store, condition} = splitConditionStore(title);
	return `${condition} — ${qty.toLocaleString('ru-RU')} шт. · ${store}`;
}
export interface StockConditionBalance { store: string; condition: StockCondition; stockTitle: string; actual: number; reserved: number; available: number }
export interface StockConditionChange { productId: number; store: string; from: StockCondition; to: StockCondition; qty: number; comment: string; operationId: string }
export interface StockConditionHistory extends StockConditionChange { document: string; actor: string; at: string; submitted: boolean }
