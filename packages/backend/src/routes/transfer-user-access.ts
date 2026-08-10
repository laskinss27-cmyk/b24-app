import type { B24Client } from '../b24/client.js';

const SUPPLY_DEPT = 10;
const SUPPLY_ADMIN_IDS = new Set(['1', '1858', '986']);
const TRANSFER_DELETE_IDS = new Set(['1858']);

export interface CurrentUser {
	id: string;
	name: string;
	isSupply: boolean;
}

export async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = SUPPLY_ADMIN_IDS.has(id) || depts.includes(SUPPLY_DEPT);
	return { id, name: `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim(), isSupply };
}

export function canDeleteTransferDocuments(userId: string): boolean {
	return TRANSFER_DELETE_IDS.has(userId);
}
