import type { B24Client } from './client.js';

/**
 * Резолв «сделка → ФИО ответственного» для складских документов.
 * Имя на любом документе = ответственный в его сделке (решение Сергея 2026-06-21),
 * неважно кто создал документ/сделку. Кэш на процесс (имена/ответственные меняются редко).
 */
const dealOwner = new Map<string, string>(); // dealId -> ФИО ответственного
const userName = new Map<string, string>(); // userId -> ФИО

export interface DealSummary {
	title: string;
	ownerName: string;
	closed: boolean;
}

/** Название, ответственный и признак закрытия для небольшого набора сделок. */
export async function resolveDealSummaries(client: B24Client, dealIds: Array<string | number>): Promise<Map<string, DealSummary>> {
	const ids = [...new Set(dealIds.map((value) => String(value)).filter((value) => value && value !== '0'))];
	const deals = new Map<string, { title: string; userId: string; closed: boolean }>();
	for (let index = 0; index < ids.length; index += 50) {
		const chunk = ids.slice(index, index + 50);
		const rows = await client.call<Array<{ ID?: string | number; TITLE?: string; ASSIGNED_BY_ID?: string | number; CLOSED?: string }>>('crm.deal.list', {
			filter: { '@ID': chunk },
			select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'CLOSED'],
		});
		for (const row of rows ?? []) {
			const id = String(row.ID ?? '');
			if (!id) continue;
			deals.set(id, {
				title: String(row.TITLE ?? '').trim() || `Сделка #${id}`,
				userId: String(row.ASSIGNED_BY_ID ?? ''),
				closed: String(row.CLOSED ?? '').toUpperCase() === 'Y',
			});
		}
	}
	const needUsers = [...new Set([...deals.values()].map((deal) => deal.userId).filter((id) => id && !userName.has(id)))];
	for (const id of needUsers) {
		try {
			const rows = await client.call<Array<{ NAME?: string; LAST_NAME?: string }>>('user.get', { ID: id });
			const user = rows?.[0];
			const name = `${String(user?.NAME ?? '').trim()} ${String(user?.LAST_NAME ?? '').trim()}`.trim();
			if (name) userName.set(id, name);
		} catch { /* карточка сделки всё равно останется доступна без ФИО */ }
	}
	return new Map([...deals].map(([id, deal]) => [id, {
		title: deal.title,
		ownerName: userName.get(deal.userId) ?? '',
		closed: deal.closed,
	}]));
}

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
