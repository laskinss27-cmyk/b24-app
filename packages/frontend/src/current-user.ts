import { call } from './bitrix-client.js';

/** Руководящие учётки: отчёты и действия, которые не относятся к рядовой работе менеджера. */
export const MANAGEMENT_USER_IDS = ['1858', '986', '1'];

/** ID текущего пользователя (для ролевых прав).
 *  КЭШ на сессию: фронтовый BX24 user.current флапает (таймаут 15с) при повторных вызовах —
 *  напр. кнопка «Реализации» в Базе монтирует ещё один гейт. Первый успешный id запоминаем,
 *  дальше отдаём из кэша, не дёргая BX24. Кэшируем и in-flight промис (дедуп параллельных). */
let _uidCache: string | null = null;
let _uidInflight: Promise<string> | null = null;
export async function fetchCurrentUserId(): Promise<string> {
	if (_uidCache) return _uidCache;
	if (_uidInflight) return _uidInflight;
	_uidInflight = (async () => {
		try {
			const u = await call<{ ID?: string | number }>('user.current');
			const id = String(u?.ID ?? '');
			if (id) _uidCache = id;
			return id;
		} finally {
			_uidInflight = null;
		}
	})();
	return _uidInflight;
}

/** Текущий пользователь: id, читаемое имя и контактный телефон. */
export async function fetchCurrentUser(): Promise<{ id: string; name: string; phone: string }> {
	const u = await call<{
		ID?: string | number;
		NAME?: string;
		LAST_NAME?: string;
		WORK_PHONE?: string;
		PERSONAL_MOBILE?: string;
		PERSONAL_PHONE?: string;
	}>('user.current');
	const id = String(u?.ID ?? '');
	const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(' ').trim() || id;
	const phone = [u?.WORK_PHONE, u?.PERSONAL_MOBILE, u?.PERSONAL_PHONE]
		.map((value) => String(value ?? '').trim())
		.find(Boolean) ?? '';
	return { id, name, phone };
}

/** Админ ли смотрящий — синхронно через BX24.isAdmin() (без REST, не виснет).
 *  Право создавать инвентаризации: «Бекасов и выше» = админы + список инициаторов (app.option). */
export function isPortalAdmin(): boolean {
	const bx = window.BX24;
	return !!(bx && typeof bx.isAdmin === 'function' && bx.isAdmin());
}
