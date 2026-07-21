import { B24ApiError, B24Client } from './client.js';

const SUPPLY_DEPT = 10;
let supplyHeadCache: number | null = null;

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

async function supplyResponsible(client: B24Client, authorId: number): Promise<number> {
	if (supplyHeadCache === null) {
		const configured = Number(process.env['REPAIR_SUPPLY_RESPONSIBLE_ID'] ?? process.env['TRANSFER_PURCHASER_ID'] ?? 0) || 0;
		if (configured) supplyHeadCache = configured;
		else {
			try {
				const departments = await client.call<Array<{ UF_HEAD?: unknown }>>('department.get', { ID: SUPPLY_DEPT });
				supplyHeadCache = Number((Array.isArray(departments) ? departments[0] : undefined)?.UF_HEAD ?? 0) || 0;
			} catch {
				supplyHeadCache = 0;
			}
		}
	}
	if (supplyHeadCache) return supplyHeadCache;
	try {
		const users = await client.call<Array<{ ID?: string | number }>>('user.get', { FILTER: { ACTIVE: true, UF_DEPARTMENT: SUPPLY_DEPT } });
		const ids = (Array.isArray(users) ? users : []).map((user) => Number(user.ID ?? 0)).filter((id) => id > 0);
		return ids.find((id) => id !== authorId) ?? ids[0] ?? 0;
	} catch {
		return 0;
	}
}

export interface SupplyTaskResult {
	taskId: number | null;
	error: string | null;
}

export async function createSupplyTask(client: B24Client, args: {
	title: string;
	description: string;
	authorId: string | number;
}): Promise<SupplyTaskResult> {
	try {
		const authorId = Number(args.authorId) || 0;
		const responsibleId = await supplyResponsible(client, authorId);
		if (!responsibleId) return { taskId: null, error: 'не найден исполнитель из отдела снабжения' };
		const response = await client.call<{ task?: { id?: number | string } }>('tasks.task.add', {
			fields: {
				TITLE: args.title,
				DESCRIPTION: args.description,
				...(authorId ? { CREATED_BY: authorId } : {}),
				RESPONSIBLE_ID: responsibleId,
			},
		});
		const taskId = Number(response?.task?.id ?? 0) || null;
		return { taskId, error: taskId ? null : 'Б24 не вернул ID задачи' };
	} catch (error) {
		return { taskId: null, error: errInfo(error) };
	}
}

export function supplyTaskUrl(
	portalDomain: string,
	appCode: string | undefined,
	params: Record<string, string | number>,
	target: 'manager' | 'supply',
): string {
	const code = String(appCode ?? '').trim();
	const configured = String(process.env['SUPPLY_SECTION_URL'] ?? '').trim();
	const base = code
		? `https://${portalDomain}/marketplace/view/${encodeURIComponent(code)}/`
		: configured || `https://${portalDomain}/devops/placement/${target === 'manager' ? '570' : '574'}/`;
	const url = new URL(base);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(code ? `params[${key}]` : key, String(value));
	}
	url.searchParams.set(code ? 'params[target]' : 'target', target);
	return url.toString();
}

export function taskLink(url: string, label: string): string {
	return `[URL=${url}]${label}[/URL]`;
}
