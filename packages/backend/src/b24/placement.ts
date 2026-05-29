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
 * Пункт «Инвентаризация» в ЛЕВОМ МЕНЮ — вход в модуль инвентаризации.
 * Заменяет задачную кнопку (TASK_VIEW_TOP_PANEL не принимается новой карточкой задач).
 */
export const INVENTORY_MENU_PLACEMENT = 'LEFT_MENU';
export const INVENTORY_MENU_TITLE = 'Инвентаризация';

export async function bindInventoryMenuPlacement(opts: BindDealTabOptions): Promise<{ status: 'bound' | 'already-bound' }> {
	const handlerUrl = `${opts.publicBaseUrl.replace(/\/$/, '')}/placement/inventory`;

	try {
		await opts.client.call('placement.bind', {
			PLACEMENT: INVENTORY_MENU_PLACEMENT,
			HANDLER: handlerUrl,
			TITLE: INVENTORY_MENU_TITLE,
			LANG_ALL: {
				ru: { TITLE: INVENTORY_MENU_TITLE },
				en: { TITLE: 'Inventory' },
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
