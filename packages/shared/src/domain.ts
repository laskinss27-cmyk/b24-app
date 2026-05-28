/**
 * Доменные модели приложения.
 *
 * Это слой между сырыми Б24-полями (b24-types.ts, сгенерированными)
 * и тем, что видит React-компонент. Если Б24 завтра переименует поле —
 * меняем только адаптер, доменные модели остаются.
 */

/** Строка товара в сделке — то, что мы рисуем в нашей таблице «Товары». */
export interface DealProductRow {
	id: number;
	productId: number;
	name: string;
	price: number;          // цена продажи
	quantity: number;
	discountSum: number;
	/** Закупочная цена. Тянется из каталога товара (PROPERTY_338 или PROPERTY_362 — уточняется в Sprint 1). */
	purchasePrice: number | null;
	/** ID склада из строки сделки (если выбран). */
	storeId: number | null;
	/** Сколько уже реализовано по этой строке (из связанных документов «Реализация»). */
	shippedQuantity: number;
}

/** Итоги для нашего блока внизу справа. Перевычисляются на фронте при изменении строк. */
export interface DealTotals {
	worksSum: number;       // Сумма работ
	worksProfit: number;    // Прибыль работ = worksSum * coefficient
	goodsSum: number;       // Сумма товаров (продажа)
	goodsProfit: number;    // Прибыль товаров = goodsSum - Σ закупочных
	discount: number;
	total: number;
}

/** Контекст, который Б24 передаёт в iframe при открытии placement-вкладки. */
export interface DealTabContext {
	dealId: number;
	userId: number;
	domain: string;         // например umniydom.bitrix24.ru
}

/** Настройка приложения, хранится в app.option.*. */
export interface AppSettings {
	/** Глобальный коэффициент прибыли работ. Default 0.5. */
	worksProfitCoefficient: number;
}
