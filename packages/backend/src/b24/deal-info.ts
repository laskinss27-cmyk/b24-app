import type { B24Client } from './client.js';

/**
 * Резолв «сделка → ФИО ответственного» для складских документов.
 * Имя на любом документе = ответственный в его сделке (решение Сергея 2026-06-21),
 * неважно кто создал документ/сделку. Кэш на процесс (имена/ответственные меняются редко).
 */
const dealOwner = new Map<string, string>(); // dealId -> ФИО ответственного
const userName = new Map<string, string>(); // userId -> ФИО

export async function resolveDealOwners(client: B24Client, dealIds: Array<string | number>): Promise<Map<string, string>> {
	const ids = [...new Set(dealIds.map((d) => String(d)).filter((d) => d && d !== '0'))];
	const missing = ids.filter((id) => !dealOwner.has(id));

	// 1) сделка → ASSIGNED_BY_ID (пачкой, @ID = IN)
	const dealAssigned = new Map<string, string>();
	for (let i = 0; i < missing.length; i += 50) {
		const chunk = missing.slice(i, i + 50);
		try {
			const deals = await client.call<Array<{ ID?: string | number; ASSIGNED_BY_ID?: string | number }>>('crm.deal.list', { filter: { '@ID': chunk }, select: ['ID', 'ASSIGNED_BY_ID'] });
			for (const d of deals ?? []) dealAssigned.set(String(d.ID), String(d.ASSIGNED_BY_ID ?? ''));
		} catch { /* сделка не прочиталась — оставим без имени */ }
	}

	// 2) ASSIGNED_BY_ID → ФИО (user.get, кэш)
	const needUsers = [...new Set([...dealAssigned.values()].filter((u) => u && !userName.has(u)))];
	for (const uid of needUsers) {
		try {
			const u = await client.call<Array<{ NAME?: string; LAST_NAME?: string }>>('user.get', { ID: uid });
			const usr = Array.isArray(u) ? u[0] : undefined;
			const nm = `${usr?.NAME ?? ''} ${usr?.LAST_NAME ?? ''}`.trim();
			if (nm) userName.set(uid, nm);
		} catch { /* юзер не прочитался */ }
	}

	for (const id of missing) {
		const uid = dealAssigned.get(id);
		dealOwner.set(id, uid ? (userName.get(uid) ?? '') : '');
	}

	const out = new Map<string, string>();
	for (const id of ids) out.set(id, dealOwner.get(id) ?? '');
	return out;
}
