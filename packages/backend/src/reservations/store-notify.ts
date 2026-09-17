/**
 * Сопоставление складов (точек) и пользователей Битрикс24 для уведомлений
 * по резервам. Формат env B24_RESERVATION_STORE_NOTIFY:
 *   "Измайловский=123,456; Склад УД=789"
 * Ключ — название склада как в Б24 (без суффикса компании ERPNext).
 */

export function normalizeStoreTitle(title: string): string {
	return title.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function loadStoreNotifyUsers(raw: string | undefined): Map<string, number[]> {
	const out = new Map<string, number[]>();
	for (const entry of String(raw ?? '').split(';')) {
		const [title, ids] = entry.split('=', 2);
		const key = normalizeStoreTitle(title ?? '');
		if (!key) continue;
		const users = [...new Set(String(ids ?? '').split(','))]
			.map((value) => Number(value.trim()))
			.filter((value) => Number.isInteger(value) && value > 0);
		if (!users.length) continue;
		out.set(key, [...new Set([...(out.get(key) ?? []), ...users])]);
	}
	return out;
}

export function resolveStoreNotifyUsers(map: ReadonlyMap<string, number[]>, storeTitle: string): number[] {
	return map.get(normalizeStoreTitle(storeTitle)) ?? [];
}
