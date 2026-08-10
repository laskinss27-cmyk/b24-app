import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { REPAIRS_ENTITY } from '../b24/placement.js';
import type { RepairData } from './repair-record.js';
import { normalizeStatus } from './repair-status.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

const SUPPLY_DEPT = 10;

let supplyHeadCache: number | null = null;
async function supplyHead(client: B24Client): Promise<number> {
	if (supplyHeadCache !== null) return supplyHeadCache;
	const env = Number(process.env['REPAIR_SUPPLY_RESPONSIBLE_ID'] ?? process.env['TRANSFER_PURCHASER_ID'] ?? 0) || 0;
	if (env) { supplyHeadCache = env; return env; }
	try {
		const deps = await client.call<Array<{ UF_HEAD?: unknown }>>('department.get', { ID: SUPPLY_DEPT });
		const head = Number((Array.isArray(deps) ? deps[0] : undefined)?.UF_HEAD ?? 0) || 0;
		supplyHeadCache = head;
		return head;
	} catch {
		supplyHeadCache = 0;
		return 0;
	}
}

async function supplyResponsible(client: B24Client, authorId: number): Promise<number> {
	const head = await supplyHead(client);
	if (head) return head;
	try {
		const users = await client.call<Array<{ ID?: string | number }>>('user.get', {
			FILTER: { ACTIVE: true, UF_DEPARTMENT: SUPPLY_DEPT },
		});
		const ids = (Array.isArray(users) ? users : []).map((u) => Number(u.ID ?? 0)).filter((id) => id > 0);
		return ids.find((id) => id !== authorId) ?? ids[0] ?? 0;
	} catch {
		return 0;
	}
}


/** Кэш id→ФИО на процесс (имена меняются редко) — чтобы не дёргать user.get на каждой загрузке. */
export const userNameCache = new Map<string, string>();

/** Дорезолвить имена сотрудников по id (для старых записей истории, где сохранён только byId). */
export async function resolveNames(client: B24Client, ids: Set<string>): Promise<void> {
	for (const uid of ids) {
		if (!uid || userNameCache.has(uid)) continue;
		try {
			const u = await client.call<Array<{ NAME?: string; LAST_NAME?: string }>>('user.get', { ID: uid });
			const usr = Array.isArray(u) ? u[0] : undefined;
			const nm = `${usr?.NAME ?? ''} ${usr?.LAST_NAME ?? ''}`.trim();
			if (nm) userNameCache.set(uid, nm);
		} catch { /* не вышло — оставим #id */ }
	}
}

interface TaskSyncResult { taskId: number | null; error: string | null }

function repairNotifyTitle(data: RepairData, repairId: number): string {
	const repairTitle = data.kind === 'presale' ? 'Предпродажный ремонт' : 'Ремонт клиента';
	return `${repairTitle} #${data.repairNo || repairId}: ${[data.device, data.model].filter(Boolean).join(' ') || 'аппарат'}`;
}

export function isFinishedRepair(data: RepairData): boolean {
	const kind = data.kind === 'presale' ? 'presale' : 'client';
	const status = normalizeStatus(data.status, kind);
	return kind === 'presale' ? status === 'pre_at_tt' : status === 'issued';
}

async function findRepairNotifyTask(client: B24Client, data: RepairData, repairId: number): Promise<number | null> {
	const title = repairNotifyTitle(data, repairId);
	const res = await client.call<{ tasks?: Array<{ id?: number | string; title?: string }> }>('tasks.task.list', {
		filter: { TITLE: title },
		select: ['ID', 'TITLE'],
		order: { ID: 'DESC' },
	});
	const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
	const exact = tasks.find((task) => String(task.title ?? '') === title) ?? tasks[0];
	return Number(exact?.id ?? 0) || null;
}

export async function createRepairNotifyTask(
	client: B24Client,
	data: RepairData,
	repairId: number,
	log: FastifyInstance['log'],
): Promise<TaskSyncResult> {
	try {
		const author = Number(data.createdById) || 0;
		const responsible = await supplyResponsible(client, author);
		if (!responsible) return { taskId: null, error: 'не найден исполнитель из отдела снабжения' };
		const repairTitle = data.kind === 'presale' ? 'Предпродажный ремонт' : 'Ремонт клиента';
		const pointLine = data.kind === 'presale'
			? `Склад-источник: ${data.sourceStore || 'не указан'}`
			: `ТТ приема: ${data.point || 'не указана'}`;
		const clientLine = data.kind === 'presale'
			? ''
			: `Клиент: ${[data.client.name, data.client.phone].filter(Boolean).join(' · ') || 'не указан'}\n`;
		const dealLine = data.dealId ? `Сделка ремонта: #${data.dealId}\n` : '';
		const body = [
			`${repairTitle} #${data.repairNo || repairId}`,
			`Запись ремонта: #${repairId}`,
			pointLine,
			clientLine.trim(),
			`Аппарат: ${[data.device, data.model].filter(Boolean).join(' ') || (data.productId ? `#${data.productId}` : 'не указан')}`,
			data.serial ? `Серийный номер: ${data.serial}` : '',
			data.defect ? `Неисправность: ${data.defect}` : '',
			data.appearance ? `Внешний вид/комплект: ${data.appearance}` : '',
			dealLine.trim(),
			`Принял: ${data.createdByName || (data.createdById ? `#${data.createdById}` : 'не указан')}`,
			'',
			'Открой раздел «Ремонты», проверь карточку и двигай ремонт по статусам.',
		].filter((line) => line !== '').join('\n');
		const task = await client.call<{ task?: { id?: number | string } }>('tasks.task.add', {
			fields: {
				TITLE: repairNotifyTitle(data, repairId),
				DESCRIPTION: body,
				...(author ? { CREATED_BY: author } : {}),
				RESPONSIBLE_ID: responsible,
			},
		});
		const taskId = Number(task?.task?.id ?? 0) || null;
		return { taskId, error: taskId ? null : 'Б24 не вернул ID задачи' };
	} catch (err) {
		const error = errInfo(err);
		log.warn({ repairId }, `[api/repairs] notify task failed — ${error}`);
		return { taskId: null, error };
	}
}

export async function ensureRepairNotifyTask(
	client: B24Client,
	repair: RepairData & { id: number; name: string },
	log: FastifyInstance['log'],
): Promise<TaskSyncResult> {
	if (repair.taskId || isFinishedRepair(repair)) return { taskId: repair.taskId ?? null, error: null };
	const { id, name, ...data } = repair;
	try {
		const found = await findRepairNotifyTask(client, data, id);
		if (found) {
			data.taskId = found;
			repair.taskId = found;
			await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
			return { taskId: found, error: null };
		}
	} catch (err) {
		const error = errInfo(err);
		log.warn({ repairId: id }, `[api/repairs] legacy task lookup failed — ${error}`);
		return { taskId: null, error };
	}
	const created = await createRepairNotifyTask(client, data, id, log);
	if (created.taskId) {
		data.taskId = created.taskId;
		repair.taskId = created.taskId;
		await client.call('entity.item.update', { ENTITY: REPAIRS_ENTITY, ID: id, NAME: name || 'Ремонт', DETAIL_TEXT: JSON.stringify(data) });
	}
	return created;
}
