import type { B24Client } from '../b24/client.js';

/** Кто может РЕДАКТИРОВАТЬ цену ремонта: Вова(1), Сергей(1858), Бекасов(986) + отдел Снабжение(10).
 * Остальные цену видят, но не меняют. Б24 не отдаёт флаг «админ» на бэке — главные админы в списке поимённо. */
const PRICE_EDITOR_IDS = new Set(['1', '1858', '986']);
const PRICE_EDITOR_DEPTS = new Set([10]);

export interface CurrentUser { id: string; name: string; canEditPrice: boolean }

/** Текущий пользователь (по его токену) + право на правку цены. user.current отдаёт UF_DEPARTMENT. */
export async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const name = `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim();
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const canEditPrice = PRICE_EDITOR_IDS.has(id) || depts.some((d) => PRICE_EDITOR_DEPTS.has(d));
	return { id, name, canEditPrice };
}
