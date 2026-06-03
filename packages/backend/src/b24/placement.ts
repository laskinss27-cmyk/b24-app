import { B24ApiError, type B24Client } from './client.js';

/**
 * Регистрация placement-вкладки в карточке сделки.
 *
 * Дёргается при установке приложения (/install handler), от OAuth-токена,
 * который Б24 передал в install body. После успешного вызова Битрикс
 * запоминает что для CRM_DEAL_DETAIL_TAB обработчик — наш URL.
 *
 * Идемпотентно: если уже зарегистрирован (юзер переустанавливает приложение),
 * Б24 возвращает ERROR_PLACEMENT_HANDLER_ALREADY_BINDED — это нормально, игнорируем.
 */

export const DEAL_TAB_PLACEMENT = 'CRM_DEAL_DETAIL_TAB';
export const DEAL_TAB_TITLE = 'b24-app';
export const DEAL_TAB_DESCRIPTION = 'Кастомная вкладка товаров — N/M отгружено, селектор склада, массовая реализация';

export interface BindDealTabOptions {
	client: B24Client;
	publicBaseUrl: string;
}

export async function bindDealTabPlacement(opts: BindDealTabOptions): Promise<{ status: 'bound' | 'already-bound' }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/deal-tab`;

	try {
		await opts.client.call('placement.bind', {
			PLACEMENT: DEAL_TAB_PLACEMENT,
			HANDLER: handlerUrl,
			TITLE: DEAL_TAB_TITLE,
			DESCRIPTION: DEAL_TAB_DESCRIPTION,
			LANG_ALL: {
				ru: { TITLE: DEAL_TAB_TITLE, DESCRIPTION: DEAL_TAB_DESCRIPTION },
				en: { TITLE: DEAL_TAB_TITLE, DESCRIPTION: 'Custom products tab for deals' },
			},
		});
		return { status: 'bound' };
	} catch (err) {
		if (err instanceof B24ApiError && /already\s*bind/i.test(err.code + ' ' + (err.description ?? ''))) {
			// Переустановка приложения — placement уже зарегистрирован, это норма
			return { status: 'already-bound' };
		}
		throw err;
	}
}

/** Кнопка «Приступить» в карточке задачи (инвентаризация). Идемпотентно. */
export const TASK_INVENTORY_PLACEMENT = 'TASK_VIEW_TOP_PANEL';
export const TASK_INVENTORY_TITLE = 'Инвентаризация';

export async function bindTaskInventoryPlacement(opts: BindDealTabOptions): Promise<{ status: 'bound' | 'already-bound' }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/task-inventory`;

	try {
		await opts.client.call('placement.bind', {
			PLACEMENT: TASK_INVENTORY_PLACEMENT,
			HANDLER: handlerUrl,
			TITLE: TASK_INVENTORY_TITLE,
			LANG_ALL: {
				ru: { TITLE: TASK_INVENTORY_TITLE, DESCRIPTION: 'Электронный отчёт инвентаризации' },
				en: { TITLE: 'Inventory', DESCRIPTION: 'Inventory report' },
			},
		});
		return { status: 'bound' };
	} catch (err) {
		if (err instanceof B24ApiError && /already\s*bind/i.test(err.code + ' ' + (err.description ?? ''))) {
			return { status: 'already-bound' };
		}
		throw err;
	}
}

/**
 * Пункт ЛЕВОГО МЕНЮ — вход в «Базу товаров» (каталог-браузер склада). Инвентаризация
 * теперь живёт ВНУТРИ Базы, поэтому пункт называется «Товары», а не «Инвентаризация».
 * Обработчик — /placement/inventory (рендерит ProductBase). LEFT_MENU — единственное
 * легальное место входа: складской учёт/каталог Битрикс приложениям не отдаёт.
 */
export const INVENTORY_MENU_PLACEMENT = 'LEFT_MENU';
export const INVENTORY_MENU_TITLE = 'Товары';

export async function bindInventoryMenuPlacement(opts: BindDealTabOptions): Promise<{ status: string }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/inventory`;
	// ВАЖНО: placement.bind НЕ меняет TITLE уже привязанного хендлера. Чтобы переименование
	// («Инвентаризация» → «Товары») реально применилось — сперва снимаем старую привязку,
	// затем биндим с актуальным названием. unbind на непривязанном — не страшно (игнорим).
	try {
		await opts.client.call('placement.unbind', { PLACEMENT: INVENTORY_MENU_PLACEMENT, HANDLER: handlerUrl });
	} catch {
		/* не была привязана — ок */
	}
	await opts.client.call('placement.bind', {
		PLACEMENT: INVENTORY_MENU_PLACEMENT,
		HANDLER: handlerUrl,
		TITLE: INVENTORY_MENU_TITLE,
		LANG_ALL: {
			ru: { TITLE: INVENTORY_MENU_TITLE },
			en: { TITLE: 'Products' },
		},
	});
	return { status: 'bound (Товары)' };
}

/**
 * ЭКСПЕРИМЕНТ (по просьбе Сергея): единственная зацепка в зоне каталога из живого
 * placement.list — `CATALOG_EXTERNAL_PRODUCT` (в публичной доке не описан). Биндим,
 * чтобы вживую увидеть, КУДА Битрикс сажает приложение в Складском учёте/каталоге.
 * Обработчик — лёгкая диагностика (/placement/catalog). НЕ throw'ит: если плейсмент
 * не поддержан (ERROR_PLACEMENT_NOT_FOUND) — вернём статус строкой, не ломая остальные бинды.
 * Внимание: бинд портально-широкий (не канарейка). После осмотра — placement.unbind.
 */
export const CATALOG_EXTERNAL_PLACEMENT = 'CATALOG_EXTERNAL_PRODUCT';
export const CATALOG_EXTERNAL_TITLE = 'База товаров';

export async function bindCatalogExternalPlacement(opts: BindDealTabOptions): Promise<{ status: string }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/catalog`;
	try {
		await opts.client.call('placement.bind', {
			PLACEMENT: CATALOG_EXTERNAL_PLACEMENT,
			HANDLER: handlerUrl,
			TITLE: CATALOG_EXTERNAL_TITLE,
			LANG_ALL: {
				ru: { TITLE: CATALOG_EXTERNAL_TITLE, DESCRIPTION: 'Каталог-браузер склада' },
				en: { TITLE: 'Product base', DESCRIPTION: 'Warehouse catalog browser' },
			},
		});
		return { status: 'bound' };
	} catch (err) {
		if (err instanceof B24ApiError) {
			if (/already\s*bind/i.test(err.code + ' ' + (err.description ?? ''))) return { status: 'already-bound' };
			return { status: `${err.code}: ${err.description ?? ''}` };
		}
		return { status: String(err) };
	}
}

/** Снять экспериментальный бинд каталога (placement.unbind). Идемпотентно. */
export async function unbindCatalogExternalPlacement(opts: BindDealTabOptions): Promise<{ status: string }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/catalog`;
	try {
		await opts.client.call('placement.unbind', { PLACEMENT: CATALOG_EXTERNAL_PLACEMENT, HANDLER: handlerUrl });
		return { status: 'unbound' };
	} catch (err) {
		if (err instanceof B24ApiError) return { status: `${err.code}: ${err.description ?? ''}` };
		return { status: String(err) };
	}
}

/**
 * Хранилище инвентаризации (entity). Создаётся с бэкенда (чистый JSON + app-контекст),
 * т.к. entity.add — админская операция и фронтовый BX24 кривит вложенный ACCESS.
 * Идемпотентно: уже существует → 'exists'. Создавать может только админ (Володя).
 */
export const INVENTORY_ENTITY = 'ctv_inv';

export async function ensureInventoryEntity(client: B24Client): Promise<{ status: string }> {
	try {
		await client.call('entity.add', { ENTITY: INVENTORY_ENTITY, NAME: 'CTV Инвентаризации', ACCESS: { AU: 'W' } });
		return { status: 'created' };
	} catch (err) {
		if (err instanceof B24ApiError) {
			if (/exist/i.test(err.code + ' ' + (err.description ?? ''))) return { status: 'exists' };
			return { status: `${err.code}: ${err.description ?? ''}` };
		}
		return { status: String(err) };
	}
}
