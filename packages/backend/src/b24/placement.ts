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
