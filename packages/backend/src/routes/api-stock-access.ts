import type { B24Client } from '../b24/client.js';
import { hasDirectMarketplaceAccess, SUPPLY_DEPARTMENT_ID } from '@b24-app/shared';

const STOCK_ADMIN_IDS = new Set(['1', '986', '1858']);

export interface StockAccess {
	canManage: boolean;
	isSupply: boolean;
	actor: { id: string; name: string };
}

export interface AssortmentMatrixAccess {
	allowed: boolean;
	actor: { id: string; name: string };
}

async function currentStockUser(client: B24Client): Promise<{
	ID?: string | number;
	NAME?: string;
	LAST_NAME?: string;
	UF_DEPARTMENT?: unknown;
	ADMIN?: boolean | string;
}> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await client.call('user.current', {});
		} catch (error) {
			lastError = error;
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 200));
		}
	}
	throw lastError;
}

export async function stockAccess(client: B24Client): Promise<StockAccess> {
	const me = await currentStockUser(client);
	const id = String(me?.ID ?? '');
	const departments = Array.isArray(me?.UF_DEPARTMENT) ? (me.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = departments.includes(SUPPLY_DEPARTMENT_ID);
	return {
		canManage: STOCK_ADMIN_IDS.has(id) || isSupply,
		isSupply,
		actor: { id, name: `${String(me?.LAST_NAME ?? '').trim()} ${String(me?.NAME ?? '').trim()}`.trim() || `#${id}` },
	};
}

export async function assortmentMatrixAccess(client: B24Client): Promise<AssortmentMatrixAccess> {
	const me = await currentStockUser(client);
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

/**
 * Операции маркетплейса доступны снабжению/складским администраторам и сотрудникам,
 * которым выдано отдельное рабочее место маркетплейса.
 */
export async function canManageMarketplace(client: B24Client): Promise<boolean> {
	const access = await stockAccess(client);
	return access.canManage || hasDirectMarketplaceAccess(access.actor.id);
}
