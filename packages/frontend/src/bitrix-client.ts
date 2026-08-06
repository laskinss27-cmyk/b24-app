/**
 * Тонкая промис-обёртка над BX24.js.
 *
 * BX24 работает на колбэках; оборачиваем их в Promise, чтобы вызывающий код мог
 * загружать данные через async/await. Запросы выполняются с правами текущего
 * пользователя портала.
 */

import type { BX24Sdk } from './b24-context.js';

function getBx24(): BX24Sdk {
	const bx = window.BX24;
	if (!bx) {
		throw new Error('BX24 SDK не загружен (нет <script src="//api.bitrix24.com/api/v1/"> в HTML).');
	}
	return bx;
}

/** Один вызов метода Б24 → Promise (только первая страница). */
export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
	return new Promise((resolve, reject) => {
		getBx24().callMethod(method, params, (res) => {
			const err = res.error();
			if (err) {
				reject(new Error(`${method}: ${typeof err === 'object' ? JSON.stringify(err) : String(err)}`));
				return;
			}
			resolve(res.data() as T);
		});
	});
}

/**
 * Собирает ВСЕ страницы list-метода. ВАЖНО: фронтовый BX24 ИГНОРИРУЕТ ручной `start`
 * в params (отдаёт первые 50 по кругу — на этом обожглись). Правильный механизм —
 * нативный: в колбэке звать `res.next()` пока `res.more()`; next() сам перезапрашивает
 * следующую страницу и снова вызывает ЭТОТ ЖЕ колбэк (start BX24 ведёт внутри сам).
 * pluck достаёт массив из data; maxPages — предохранитель от бесконечного цикла.
 */
export function callPaged<T>(method: string, params: Record<string, unknown>, pluck: (d: unknown) => T[], maxPages = 200): Promise<T[]> {
	return new Promise<T[]>((resolve, reject) => {
		const out: T[] = [];
		let pages = 0;
		getBx24().callMethod(method, params, (res) => {
			const err = res.error();
			if (err) {
				reject(new Error(`${method}: ${typeof err === 'object' ? JSON.stringify(err) : String(err)}`));
				return;
			}
			out.push(...pluck(res.data()));
			pages++;
			const hasMore = typeof res.more === 'function' && res.more();
			if (hasMore && pages < maxPages && typeof res.next === 'function') {
				res.next(); // перезапрос следующей страницы → этот колбэк вызовется снова
			} else {
				resolve(out);
			}
		});
	});
}

/**
 * Пакетный вызов (до 50 операций за раз). Ошибку отдельного вызова не валит весь
 * батч — такой ключ просто получит null.
 */
export function callBatch(calls: Record<string, [string, Record<string, unknown>]>): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		getBx24().callBatch(calls, (results) => {
			const out: Record<string, unknown> = {};
			for (const key of Object.keys(calls)) {
				const r = results[key];
				out[key] = r && !r.error() ? r.data() : null;
			}
			resolve(out);
		});
	});
}

/** Promise с таймаутом — чтобы зависший BX24-вызов не вешал UI навечно. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<T>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`таймаут: ${label} (>${Math.round(ms / 1000)}с)`)), ms);
	});
	return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}
