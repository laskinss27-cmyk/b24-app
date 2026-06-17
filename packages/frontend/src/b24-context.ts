/**
 * Контекст, прокинутый из бэкенда в iframe через window.__B24_CONTEXT__.
 * На dev — мок (см. index.html).
 */

export interface B24Context {
	dealId: number | null;
	/** id задачи — устаревший путь (task placement не принимается новой карточкой). */
	taskId?: number | null;
	/** какой экран рендерить. 'inventory' — модуль (левое меню); 'mobileCount' — мобильный подсчёт (/m); 'salesReport' — отчёт по продажам (меню сделок); 'repairs' — ремонты (левое меню). */
	view?: 'inventory' | 'mobileCount' | 'salesReport' | 'repairs' | null;
	domain: string | null;
	memberId: string | null;
	/** Мобильный режим (/m, вне iframe): токен/точка/юзер приходят в контексте, BX24 SDK нет. */
	accessToken?: string;
	inventoryId?: string;
	storeId?: number;
	me?: { id: string; name: string };
	/** true только когда контекст подставлен моком в index.html (dev) */
	__mock?: boolean;
}

declare global {
	interface Window {
		__B24_CONTEXT__?: B24Context;
		BX24?: BX24Sdk;
	}
}

export function getContext(): B24Context {
	const ctx = window.__B24_CONTEXT__;
	if (!ctx) {
		// На dev уже подставлен моком в index.html. Если попали сюда — что-то поломано.
		throw new Error('window.__B24_CONTEXT__ не найден. На dev должен быть mock из index.html, на prod — заинжектен backend-ом.');
	}
	return ctx;
}

/** Минимальная типизация BX24.js SDK — расширяем по мере использования. */
export interface BX24Sdk {
	init(callback: () => void): void;
	installFinish(): void;
	callMethod(
		method: string,
		params: Record<string, unknown>,
		callback: (result: { data(): unknown; error(): unknown; total?(): number; more?(): boolean; next?(): void }) => void,
	): void;
	callBatch(
		calls: Record<string, [string, Record<string, unknown>]>,
		callback: (results: Record<string, { data(): unknown; error(): unknown }>) => void,
	): void;
	getAuth(): { access_token?: string; domain?: string; member_id?: string } | false;
	/** true, если смотрящий — администратор портала (синхронно, без REST). */
	isAdmin(): boolean;
	resizeWindow(width: number, height: number): void;
	fitWindow(): void;
	/** Открыть путь портала (слайдером/навигацией) — напр. карточку складского документа. */
	openPath(path: string, callback?: () => void): void;
}
