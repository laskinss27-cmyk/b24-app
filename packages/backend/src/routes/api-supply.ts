import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listSupplyRequests, createSupplyRequest, createPurchaseOrderDraft, createSupplyPurchaseReceipt, updateSupplyPurchaseStage, SUPPLY_PURCHASE_EXPECTED_AT_FIELD, SUPPLY_PURCHASE_ORDERED_AT_FIELD, SUPPLY_PURCHASE_STAGE_FIELD, SUPPLY_REQUEST_FIELD, type SupplyPurchaseStage } from '../erp/operations.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';

/**
 * API рабочего места «Снаб». Источник спроса — ЗАЯВКИ (Material Request) ядра по сделкам:
 * менеджер из сделки осознанно отправляет нехватку в снабжение (кнопка «Снабжение»).
 *  - /api/supply/orders  — все заявки из ядра (позиции + комментарии + остатки) + название сделки из Б24.
 *  - /api/supply/request — создать заявку по выбранным товарам сделки.
 * Канарейку режет фронт. Токен юзера, домен — allowlist портала.
 */
// «Обеспечено» — снабженец отработал заявку (статусы Material Request).
const MR_DONE = new Set(['Ordered', 'Transferred', 'Issued', 'Received', 'Stopped']);
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

interface TransferLine { productId: number; name: string; qty: number; rate?: number }
interface TransferProgress {
	id: number;
	name: string;
	supplyRequest: string;
	status: string;
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	receivedLines: TransferLine[];
	shortageLines: TransferLine[];
}
interface PurchaseReceiptChild { name: string; status: string; lines: TransferLine[] }
interface PurchaseChild {
	name: string;
	supplier: string;
	status: string;
	supplyStage: string;
	orderedAt: string;
	expectedAt: string;
	total: number;
	lines: TransferLine[];
	receipts: PurchaseReceiptChild[];
}

function parseTransferProgress(it: Record<string, unknown>): TransferProgress | null {
	try {
		const data = it['DETAIL_TEXT'] ? JSON.parse(String(it['DETAIL_TEXT'])) as Record<string, unknown> : {};
		const supplyRequest = String(data['supplyRequest'] ?? '');
		if (!supplyRequest) return null;
		const status = String(data['status'] ?? '');
		const rawLines = Array.isArray(data['lines']) ? data['lines'] as Array<Record<string, unknown>> : [];
		const rawReceived = Array.isArray(data['receivedLines']) ? data['receivedLines'] as Array<Record<string, unknown>> : [];
		const rawShortage = Array.isArray(data['shortageLines']) ? data['shortageLines'] as Array<Record<string, unknown>> : [];
		const mapLine = (l: Record<string, unknown>): TransferLine => ({ productId: Number(l['productId']), name: String(l['name'] ?? ''), qty: Number(l['qty']) });
		return {
			id: Number(it['ID'] ?? it['id'] ?? 0),
			name: String(it['NAME'] ?? it['name'] ?? ''),
			supplyRequest,
			status,
			fromStore: String(data['fromStore'] ?? ''),
			toStore: String(data['toStore'] ?? ''),
			lines: rawLines.map(mapLine).filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
			receivedLines: rawReceived.map(mapLine).filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
			shortageLines: rawShortage.map(mapLine).filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
		};
	} catch {
		return null;
	}
}

async function listPurchaseChildren(erp: ErpClient, requestNames: string[]): Promise<Map<string, PurchaseChild[]>> {
	const out = new Map<string, PurchaseChild[]>();
	if (!requestNames.length) return out;
	try {
		const receipts = new Map<string, PurchaseReceiptChild[]>();
		const receiptHeaders = await erp.list<Record<string, unknown>>(
			'Purchase Receipt',
			['name', 'status', SUPPLY_REQUEST_FIELD],
			[[SUPPLY_REQUEST_FIELD, 'in', requestNames], ['docstatus', '!=', 2]],
			0,
			'creation desc',
		);
		for (const h of receiptHeaders) {
			const requestName = String(h[SUPPLY_REQUEST_FIELD] ?? '');
			if (!requestName) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Receipt', String(h['name']));
			const rawItems = Array.isArray(full?.['items']) ? full['items'] as Array<Record<string, unknown>> : [];
			const child: PurchaseReceiptChild = {
				name: String(h['name'] ?? ''),
				status: String(h['status'] ?? ''),
				lines: rawItems
					.map((l) => ({ productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty: Number(l['qty'] ?? 0), rate: Number(l['rate'] ?? 0) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
			};
			receipts.set(requestName, [...(receipts.get(requestName) ?? []), child]);
		}
		const headers = await erp.list<Record<string, unknown>>(
			'Purchase Order',
			['name', 'supplier', 'status', SUPPLY_REQUEST_FIELD],
			[[SUPPLY_REQUEST_FIELD, 'in', requestNames], ['docstatus', '!=', 2]],
			0,
			'creation desc',
		);
		for (const h of headers) {
			const requestName = String(h[SUPPLY_REQUEST_FIELD] ?? '');
			if (!requestName) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Order', String(h['name']));
			const rawItems = Array.isArray(full?.['items']) ? full['items'] as Array<Record<string, unknown>> : [];
			const child: PurchaseChild = {
				name: String(h['name'] ?? ''),
				supplier: String(h['supplier'] ?? ''),
				status: String(h['status'] ?? ''),
				supplyStage: String(full?.[SUPPLY_PURCHASE_STAGE_FIELD] ?? '') || 'draft',
				orderedAt: String(full?.[SUPPLY_PURCHASE_ORDERED_AT_FIELD] ?? ''),
				expectedAt: String(full?.[SUPPLY_PURCHASE_EXPECTED_AT_FIELD] ?? full?.['schedule_date'] ?? ''),
				total: Number(full?.['grand_total'] ?? 0),
				lines: rawItems
					.map((l) => ({ productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty: Number(l['qty'] ?? 0), rate: Number(l['rate'] ?? 0) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
				receipts: [],
			};
			out.set(requestName, [...(out.get(requestName) ?? []), child]);
		}
		for (const [requestName, rows] of receipts.entries()) {
			const purchases = out.get(requestName);
			if (purchases?.[0]) purchases[0].receipts = rows;
			else out.set(requestName, [{ name: 'Приходы без заказа поставщику', supplier: '', status: 'Received', supplyStage: 'received', orderedAt: '', expectedAt: '', total: 0, lines: [], receipts: rows }]);
		}
	} catch {
		// Старые инсталляции без поля b24_supply_request просто не покажут дочерние закупки.
	}
	return out;
}

function addCovered(covered: Map<string, Map<number, number>>, requestName: string, lines: TransferLine[]): void {
	const byProduct = covered.get(requestName) ?? new Map<number, number>();
	for (const l of lines) byProduct.set(l.productId, (byProduct.get(l.productId) ?? 0) + l.qty);
	covered.set(requestName, byProduct);
}

export function registerApiSupplyRoute(app: FastifyInstance): void {
	const clientFrom = (b: AuthBody): B24Client | null => {
		if (!b.domain || !b.accessToken) return null;
		if (normalizeDomain(b.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: b.domain, accessToken: b.accessToken } });
	};

	app.post('/api/supply/orders', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return { ok: true, orders: [] as unknown[] };
		try {
			const reqs = await listSupplyRequests(erp);
			// Название сделки — из Б24 (одним батч-вызовом по списку dealId). Статус «обеспечено» — из самой заявки.
			const dealIds = [...new Set(reqs.map((o) => Number(o.dealId)).filter((n) => Number.isInteger(n) && n > 0))];
			const titleMap = new Map<number, string>();
			if (dealIds.length) {
				const deals = await client.call<Array<Record<string, unknown>>>('crm.deal.list', {
					filter: { '@ID': dealIds }, select: ['ID', 'TITLE'],
				}).catch(() => [] as Array<Record<string, unknown>>);
				for (const d of deals ?? []) titleMap.set(Number(d['ID']), String(d['TITLE'] ?? ''));
			}
			const covered = new Map<string, Map<number, number>>();
			const transfersByRequest = new Map<string, TransferProgress[]>();
			try {
				await ensureTransfersEntity(client);
				const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
				for (const t of (transferItems ?? []).map(parseTransferProgress).filter((x): x is TransferProgress => x != null)) {
					transfersByRequest.set(t.supplyRequest, [...(transfersByRequest.get(t.supplyRequest) ?? []), t]);
					const lines = t.status === 'shortage' ? t.receivedLines : t.status === 'received' ? t.lines : [];
					addCovered(covered, t.supplyRequest, lines);
				}
			} catch {
				// Если старое хранилище перемещений недоступно, заявки всё равно покажем как есть.
			}
			const purchasesByRequest = await listPurchaseChildren(erp, reqs.map((o) => o.name));
			for (const [requestName, purchases] of purchasesByRequest.entries()) {
				for (const receipt of purchases.flatMap((p) => p.receipts)) addCovered(covered, requestName, receipt.lines);
			}
			const enriched = reqs.map((o) => {
				const byProduct = covered.get(o.name) ?? new Map<number, number>();
				const remaining = o.items
					.map((item) => ({ ...item, qty: Math.max(item.qty - (byProduct.get(item.productId) ?? 0), 0) }))
					.filter((item) => item.qty > 0);
				const closedByProgress = o.items.length > 0 && remaining.length === 0;
				return {
					...o,
					items: remaining,
					originalItems: o.items,
					transfers: transfersByRequest.get(o.name) ?? [],
					purchases: purchasesByRequest.get(o.name) ?? [],
					dealTitle: titleMap.get(Number(o.dealId)) ?? '',
					closed: MR_DONE.has(o.status) || closedByProgress,
				};
			});
			app.log.info({ reqs: enriched.length }, '[api/supply/orders] ok');
			return { ok: true, orders: enriched };
		} catch (err) {
			app.log.error({}, `[api/supply/orders] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Создать заявку в снабжение по выбранным товарам сделки (из вкладки «Товары»).
	app.post('/api/supply/request', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; lines?: unknown; toStore?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; note?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), note: String(l.note ?? '').trim() }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для заявки' });
		try {
			const scheduleDate = new Date().toISOString().slice(0, 10);
			const toStore = String(b.toStore ?? '').trim();
			const { name } = await createSupplyRequest(erp, { dealId, scheduleDate, ...(toStore ? { toStore } : {}), lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, ...(l.itemName ? { itemName: l.itemName } : {}), ...(l.note ? { note: l.note } : {}) })) });
			app.log.info({ dealId, lines: lines.length, name }, '[api/supply/request] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId }, `[api/supply/request] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; supplier?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const supplier = String(b.supplier ?? '').trim();
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			const scheduleDate = new Date().toISOString().slice(0, 10);
			const { name } = await createPurchaseOrderDraft(erp, { dealId, supplyRequest: requestName, scheduleDate, ...(supplier ? { supplier } : {}), lines });
			app.log.info({ dealId, requestName, supplier, lines: lines.length, name }, '[api/supply/purchase-order] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName }, `[api/supply/purchase-order] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-stage', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown; stage?: unknown; expectedAt?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const stage = String(b.stage ?? '').trim() as SupplyPurchaseStage;
		if (!['draft', 'approval', 'approved', 'ordered', 'cancelled'].includes(stage)) return reply.code(400).send({ ok: false, error: 'bad stage' });
		const expectedAt = String(b.expectedAt ?? '').trim();
		try {
			const { name } = await updateSupplyPurchaseStage(erp, { purchaseOrder, stage, ...(expectedAt ? { expectedAt } : {}) });
			app.log.info({ purchaseOrder, stage, name }, '[api/supply/purchase-stage] updated');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ purchaseOrder, stage }, `[api/supply/purchase-stage] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-receive', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; purchaseOrder?: unknown; toStore?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const toStore = String(b.toStore ?? '').trim();
		if (!toStore) return reply.code(400).send({ ok: false, error: 'bad toStore' });
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет фактически полученных позиций' });
		try {
			const { name } = await createSupplyPurchaseReceipt(erp, { dealId, supplyRequest: requestName, purchaseOrder, toStore, lines });
			app.log.info({ dealId, requestName, purchaseOrder, lines: lines.length, name }, '[api/supply/purchase-receive] received');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName, purchaseOrder }, `[api/supply/purchase-receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
