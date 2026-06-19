import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { shipTransferToTransit, receiveTransferFromTransit } from '../erp/operations.js';

/**
 * API модуля «Перемещения» (складской учёт). Документ перемещения — в нашем entity-store
 * ctv_transfers (JSON в DETAIL_TEXT), движение остатков — проводки в ядре через ErpClient.
 * Честный транзит: «Отгрузил» (А→Goods In Transit) и «Получил» (транзит→Б) — две проводки.
 * Статусы двигает ЗАКУПКА; менеджеры точек общаются в задаче Б24. См. спеку project_stock_transfer.
 *
 *  - /api/transfers/create   — менеджер сделки: создать перемещение(я) из сделки → черновик «Запрошено» + задача
 *  - /api/transfers/list     — список (по сделке для вкладки, без сделки — для окна закупки)
 *  - /api/transfers/ship     — закупка: «В пути» (проводка А→транзит)
 *  - /api/transfers/receive  — закупка: «Получено» (проводка транзит→Б)
 *
 * Токен — самого юзера (права Б24 соблюдаются). Домен — allowlist портала.
 */
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export type TransferStatus = 'requested' | 'in_transit' | 'received' | 'canceled';

interface TransferLine { productId: number; name: string; qty: number }

interface TransferData {
	dealId: string;
	/** Склад-получатель (склад реализации сделки) — название склада Б24. */
	toStore: string;
	/** Склад-источник — один на документ (несколько источников = несколько документов). */
	fromStore: string;
	status: TransferStatus;
	lines: TransferLine[];
	taskId: number | null;
	/** Имена проведённых Stock Entry: отгрузка (А→транзит) и приёмка (транзит→Б). */
	shipEntry: string | null;
	receiveEntry: string | null;
	createdAt: string;
	createdById: string;
	createdByName: string;
	history: Array<{ at: string; status: TransferStatus; byId: string; byName?: string; note?: string }>;
}

/** Закупка = отдел Снабжение (UF_DEPARTMENT 10) + главные админы поимённо (как в ремонтах).
 *  Только они двигают статусы перемещения (В пути/Получено). */
const SUPPLY_DEPT = 10;
const SUPPLY_ADMIN_IDS = new Set(['1', '1858', '986']);

interface CurrentUser { id: string; name: string; isSupply: boolean }
async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string; UF_DEPARTMENT?: unknown }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	const depts = Array.isArray(me?.UF_DEPARTMENT) ? (me?.UF_DEPARTMENT as unknown[]).map(Number) : [];
	const isSupply = SUPPLY_ADMIN_IDS.has(id) || depts.includes(SUPPLY_DEPT);
	return { id, name: `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim(), isSupply };
}

/** Кому ставить задачу: глава отдела Снабжения (department.get UF_HEAD), либо env, либо инициатор. Кэш на процесс. */
let supplyHeadCache: number | null = null;
async function supplyHead(client: B24Client): Promise<number> {
	if (supplyHeadCache !== null) return supplyHeadCache;
	const env = Number(process.env['TRANSFER_PURCHASER_ID'] ?? 0) || 0;
	if (env) { supplyHeadCache = env; return env; }
	try {
		const deps = await client.call<Array<{ UF_HEAD?: unknown }>>('department.get', { ID: SUPPLY_DEPT });
		const head = Number((Array.isArray(deps) ? deps[0] : undefined)?.UF_HEAD ?? 0) || 0;
		supplyHeadCache = head;
		return head;
	} catch { supplyHeadCache = 0; return 0; }
}

/** entity.item → {id, name, ...data}. */
function parseItem(it: Record<string, unknown>): (TransferData & { id: number; name: string }) | null {
	let data: Partial<TransferData> = {};
	try { data = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as Partial<TransferData>) : {}; } catch { return null; }
	const id = Number(it['ID']);
	if (!Number.isInteger(id) || id <= 0) return null;
	return {
		id,
		name: String(it['NAME'] ?? ''),
		dealId: String(data.dealId ?? ''),
		toStore: String(data.toStore ?? ''),
		fromStore: String(data.fromStore ?? ''),
		status: (['requested', 'in_transit', 'received', 'canceled'] as const).includes(data.status as TransferStatus) ? (data.status as TransferStatus) : 'requested',
		lines: Array.isArray(data.lines) ? data.lines : [],
		taskId: typeof data.taskId === 'number' ? data.taskId : null,
		shipEntry: data.shipEntry ?? null,
		receiveEntry: data.receiveEntry ?? null,
		createdAt: data.createdAt ?? '',
		createdById: data.createdById ?? '',
		createdByName: data.createdByName ?? '',
		history: Array.isArray(data.history) ? data.history : [],
	};
}

export function registerApiTransfersRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	/** Прочитать один документ перемещения из хранилища. */
	const loadOne = async (client: B24Client, id: number): Promise<(TransferData & { id: number; name: string }) | null> => {
		const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, FILTER: { ID: id } });
		const raw = (items ?? [])[0];
		return raw ? parseItem(raw) : null;
	};

	/** Сохранить изменённый JSON документа. */
	const saveData = async (client: B24Client, id: number, name: string, data: TransferData): Promise<void> => {
		await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: name, DETAIL_TEXT: JSON.stringify(data) });
	};

	// ── Создание перемещения(й) из сделки ───────────────────────────────────────
	// body: { dealId, toStore, groups: [{ fromStore, lines: [{productId, name, qty}] }] }
	app.post('/api/transfers/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = String(b['dealId'] ?? '').trim();
		const toStore = String(b['toStore'] ?? '').trim();
		const groups = Array.isArray(b['groups']) ? (b['groups'] as Array<Record<string, unknown>>) : [];
		if (!dealId || !toStore || !groups.length) return reply.code(400).send({ ok: false, error: 'нужны dealId, toStore и хотя бы одна группа источника' });
		await ensureTransfersEntity(client);
		try {
			const me = await currentUser(client);
			const now = new Date().toISOString();
			const head = await supplyHead(client);
			const created: Array<TransferData & { id: number; name: string }> = [];

			for (const g of groups) {
				const fromStore = String(g['fromStore'] ?? '').trim();
				const rawLines = Array.isArray(g['lines']) ? (g['lines'] as Array<Record<string, unknown>>) : [];
				const lines: TransferLine[] = rawLines
					.map((l) => ({ productId: Number(l['productId']), name: String(l['name'] ?? ''), qty: Number(l['qty']) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
				if (!fromStore || fromStore === toStore || !lines.length) continue;

				const data: TransferData = {
					dealId, toStore, fromStore, status: 'requested', lines,
					taskId: null, shipEntry: null, receiveEntry: null,
					createdAt: now, createdById: me.id, createdByName: me.name,
					history: [{ at: now, status: 'requested', byId: me.id, byName: me.name }],
				};
				const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
				const added = await client.call<number | { id?: number }>('entity.item.add', {
					ENTITY: TRANSFERS_ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(data),
				});
				const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
				if (!id) throw new Error('entity.item.add не вернул id');

				// Задача Б24: ответственный — закупка (env), иначе инициатор; инициатор — соисполнитель.
				try {
					const responsible = head || Number(me.id);
					const accomplices = head && me.id && head !== Number(me.id) ? [Number(me.id)] : [];
					const listText = lines.map((l) => `• ${l.name || '#' + l.productId} × ${l.qty}`).join('\n');
					const task = await client.call<{ task?: { id?: number | string } }>('tasks.task.add', {
						fields: {
							TITLE: `Перемещение: ${fromStore} → ${toStore} (сделка #${dealId})`,
							DESCRIPTION: `Запрос на перемещение со склада «${fromStore}» на «${toStore}». Основание — сделка #${dealId}.\n\n${listText}\n\nМенеджер ${fromStore}: собери и отпиши тут. Закупка проведёт «В пути» → «Получено».`,
							RESPONSIBLE_ID: responsible,
							...(accomplices.length ? { ACCOMPLICES: accomplices } : {}),
						},
					});
					const taskId = Number(task?.task?.id ?? 0) || null;
					if (taskId) { data.taskId = taskId; await saveData(client, id, itemName, data); }
				} catch (e) {
					app.log.warn({}, `[api/transfers/create] task failed — ${errInfo(e)}`);
				}
				created.push({ id, name: itemName, ...data });
			}

			if (!created.length) return reply.code(400).send({ ok: false, error: 'нет валидных групп для перемещения' });
			app.log.info({ n: created.length, dealId }, '[api/transfers/create] ok');
			return { ok: true, transfers: created };
		} catch (err) {
			app.log.error({}, `[api/transfers/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ── Список перемещений (по сделке — для вкладки; без — все для окна закупки) ──
	app.post('/api/transfers/list', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureTransfersEntity(client);
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			let transfers = (items ?? []).map(parseItem).filter((t): t is TransferData & { id: number; name: string } => t != null);
			const dealId = String(b.dealId ?? '').trim();
			if (dealId) transfers = transfers.filter((t) => t.dealId === dealId);
			const me = await currentUser(client);
			return { ok: true, transfers, isSupply: me.isSupply };
		} catch (err) {
			app.log.error({}, `[api/transfers/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ── Закупка: «В пути» (проводка А→транзит) ───────────────────────────────────
	app.post('/api/transfers/ship', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const doc = await loadOne(client, id);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'requested') return reply.code(409).send({ ok: false, error: `нельзя «в пути» из статуса ${doc.status}` });
			const me = await currentUser(client);
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'двигать статус может только снабжение (закупка)' });
			const did = Number(doc.dealId) || 0;
			const { name: entryName } = await shipTransferToTransit(erp, {
				...(did ? { dealId: did } : {}),
				lines: doc.lines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore: doc.fromStore })),
			});
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc, status: 'in_transit', shipEntry: entryName,
				history: [...doc.history, { at: now, status: 'in_transit', byId: me.id, byName: me.name, note: `Stock Entry ${entryName}` }],
			};
			await saveData(client, id, doc.name, data);
			app.log.info({ id, entryName }, '[api/transfers/ship] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({}, `[api/transfers/ship] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// ── Закупка: «Получено» (проводка транзит→Б) ─────────────────────────────────
	app.post('/api/transfers/receive', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		try {
			const doc = await loadOne(client, id);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (doc.status !== 'in_transit') return reply.code(409).send({ ok: false, error: `нельзя «получено» из статуса ${doc.status}` });
			const me = await currentUser(client);
			if (!me.isSupply) return reply.code(403).send({ ok: false, error: 'двигать статус может только снабжение (закупка)' });
			const did = Number(doc.dealId) || 0;
			const { name: entryName } = await receiveTransferFromTransit(erp, {
				...(did ? { dealId: did } : {}),
				lines: doc.lines.map((l) => ({ productId: l.productId, qty: l.qty, toStore: doc.toStore })),
			});
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc, status: 'received', receiveEntry: entryName,
				history: [...doc.history, { at: now, status: 'received', byId: me.id, byName: me.name, note: `Stock Entry ${entryName}` }],
			};
			await saveData(client, id, doc.name, data);
			app.log.info({ id, entryName }, '[api/transfers/receive] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({}, `[api/transfers/receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
