import type { B24Client } from '../b24/client.js';
import { SUPPLY_DEPARTMENT_ID } from '@b24-app/shared';

const STOCK_ADMIN_IDS = new Set(['1', '986', '1858']);
// Verified portal identities: Савченко Николай, Маркетплейсович Николай.
const SHELLY_ISSUE_USER_IDS = new Set(['760', '3608']);
export const SHELLY_ISSUE_STORE = 'Shelly';

export interface StockAccess {
	canManage: boolean;
	isSupply: boolean;
	canIssueShelly: boolean;
}

export interface AssortmentMatrixAccess {
	allowed: boolean;
	actor: { id: string; name: string };
}

export async function stockAccess(client: B24Client): Promise<StockAccess> {
	const me = await client.call<{ ID?: string | number; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const departments = Array.isArray(me?.UF_DEPARTMENT) ? (me.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = departments.includes(SUPPLY_DEPARTMENT_ID);
	return { canManage: STOCK_ADMIN_IDS.has(id) || isSupply, isSupply, canIssueShelly: SHELLY_ISSUE_USER_IDS.has(id) };
}

/** Never grant general stock management through this warehouse-scoped exception. */
export function isShellyIssueDocument(document: Record<string, unknown> | null, warehouse: string): boolean {
	if (!document) return false;
	const lines = document['items'];
	return document['stock_entry_type'] === 'Material Issue'
		&& document['purpose'] === 'Material Issue'
		&& Number(document['docstatus']) === 0
		&& (!document['from_warehouse'] || document['from_warehouse'] === warehouse)
		&& !document['to_warehouse']
		&& Array.isArray(lines) && lines.length > 0
		&& lines.every((line: Record<string, unknown>) => line && line['s_warehouse'] === warehouse && !line['t_warehouse']);
}

export async function assortmentMatrixAccess(client: B24Client): Promise<AssortmentMatrixAccess> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown; ADMIN?: boolean | string }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const departments = Array.isArray(me?.UF_DEPARTMENT) ? (me.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = departments.includes(SUPPLY_DEPARTMENT_ID);
	const isAdmin = STOCK_ADMIN_IDS.has(id) || me?.ADMIN === true || String(me?.ADMIN ?? '').toUpperCase() === 'Y';
	return {
		allowed: Boolean(id) && (isSupply || isAdmin),
		actor: { id, name: `${String(me?.LAST_NAME ?? '').trim()} ${String(me?.NAME ?? '').trim()}`.trim() || `#${id}` },
	};
}

export async function canUseAssortmentMatrix(client: B24Client): Promise<boolean> {
	return (await assortmentMatrixAccess(client)).allowed;
}

export async function canManageStock(client: B24Client): Promise<boolean> {
	return (await stockAccess(client)).canManage;
}
