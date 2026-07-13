import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import { listSupplyRequests, createSupplyRequest, createPurchaseOrderDraft, updatePurchaseOrderDraft, createSupplyPurchaseReceipt, updateSupplyPurchaseStage, shipTransferToTransit, SUPPLY_PURCHASE_EXPECTED_AT_FIELD, SUPPLY_PURCHASE_ORDER_FIELD, SUPPLY_PURCHASE_ORDERED_AT_FIELD, SUPPLY_PURCHASE_REQUEST_QTY_FIELD, SUPPLY_PURCHASE_STAGE_FIELD, SUPPLY_REQUEST_FIELD, SUPPLY_REQUEST_KEY_FIELD, type SupplyPurchaseStage, type SupplyRequest } from '../erp/operations.js';
import { TRANSFERS_ENTITY, ensureTransfersEntity } from '../b24/placement.js';

/**
 * API рабочего места «Снаб». Источник спроса — ЗАЯВКИ (Material Request) ядра по сделкам:
 * менеджер из сделки осознанно отправляет нехватку в снабжение (кнопка «Снабжение»).
 *  - /api/supply/orders  — все заявки из ядра (позиции + комментарии + остатки) + название сделки из Б24.
 *  - /api/supply/request — создать заявку по выбранным товарам сделки.
 * Канарейку режет фронт. Токен юзера, домен — allowlist портала.
 */
// «Обеспечено» — снабженец отработал заявку (статусы Material Request).
const MR_DONE = new Set(['Transferred', 'Issued', 'Received', 'Stopped']);
interface AuthBody { domain?: string; accessToken?: string }

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

interface TransferLine { productId: number; name: string; qty: number; rate?: number; warehouse?: string; requestQty?: number }
interface TransferProgress {
	id: number;
	name: string;
	supplyRequest: string;
	supplyRequestKey: string;
	dealId: string;
	createdAt: string;
	purchaseOrder: string;
	status: string;
	fromStore: string;
	toStore: string;
	lines: TransferLine[];
	receivedLines: TransferLine[];
	shortageLines: TransferLine[];
}
interface PurchaseReceiptChild { name: string; status: string; purchaseOrder: string; lines: TransferLine[] }
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
interface SupplyDecisionLine {
	productId: number;
	itemName: string;
	qty: number;
	action: 'transfer' | 'purchase';
	fromStore: string;
	supplier: string;
}
interface CurrentUser { id: string; name: string }
const SUPPLY_DOCUMENT_DELETE_IDS = new Set(['1858']);

let supplierCatId: number | null = null;
const supplyCreationLocks = new Set<string>();
async function supplierCategoryId(client: B24Client): Promise<number> {
	if (supplierCatId !== null) return supplierCatId;
	try {
		const r = await client.call<{ categories?: Array<{ id?: number; code?: string }> }>('crm.category.list', { entityTypeId: 4 });
		const cat = (r?.categories ?? []).find((c) => c.code === 'CATALOG_CONTRACTOR_COMPANY');
		supplierCatId = cat ? Number(cat.id) : 8;
	} catch { supplierCatId = 8; }
	return supplierCatId;
}

const supplierNorm = (name: string): string => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
async function fetchSupplierCompanies(client: B24Client): Promise<string[]> {
	const out: string[] = [];
	const categoryId = await supplierCategoryId(client);
	for (let start = 0; start < 2000; start += 50) {
		const r = await client.call<{ items?: Array<{ title?: string }> }>('crm.item.list', { entityTypeId: 4, filter: { categoryId }, select: ['id', 'title'], start });
		const items = r?.items ?? [];
		if (!items.length) break;
		for (const it of items) { const t = String(it.title ?? '').trim(); if (t) out.push(t); }
		if (items.length < 50) break;
	}
	return [...new Set(out)].sort((a, b) => a.localeCompare(b, 'ru'));
}

async function ensureB24SupplierCompany(client: B24Client, name: string): Promise<void> {
	const clean = name.trim();
	if (!clean || clean === 'Поставщик не выбран') return;
	const suppliers = await fetchSupplierCompanies(client).catch(() => []);
	if (suppliers.some((s) => supplierNorm(s) === supplierNorm(clean))) return;
	const categoryId = await supplierCategoryId(client);
	await client.call('crm.item.add', { entityTypeId: 4, fields: { title: clean, categoryId } });
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
			supplyRequestKey: String(data['supplyRequestKey'] ?? ''),
			dealId: String(data['dealId'] ?? ''),
			createdAt: String(data['createdAt'] ?? ''),
			purchaseOrder: String(data['purchaseOrder'] ?? ''),
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

function belongsToRequest(request: SupplyRequest, requestKey: string): boolean {
	return Boolean(requestKey) && requestKey === request.requestKey;
}

function transferBelongsToRequest(transfer: TransferProgress, request: SupplyRequest): boolean {
	return transfer.supplyRequest === request.name
		&& belongsToRequest(request, transfer.supplyRequestKey);
}

async function listPurchaseChildren(erp: ErpClient, requests: SupplyRequest[]): Promise<Map<string, PurchaseChild[]>> {
	const out = new Map<string, PurchaseChild[]>();
	if (!requests.length) return out;
	const requestNames = requests.map((request) => request.name);
	const byName = new Map(requests.map((request) => [request.name, request]));
	try {
		const receipts = new Map<string, PurchaseReceiptChild[]>();
		const receiptHeaders = await erp.list<Record<string, unknown>>(
			'Purchase Receipt',
			['name', 'status', SUPPLY_REQUEST_FIELD, SUPPLY_PURCHASE_ORDER_FIELD],
			[[SUPPLY_REQUEST_FIELD, 'in', requestNames], ['docstatus', '!=', 2]],
			0,
			'creation desc',
		);
		for (const h of receiptHeaders) {
			const requestName = String(h[SUPPLY_REQUEST_FIELD] ?? '');
			const request = byName.get(requestName);
			if (!request) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Receipt', String(h['name']));
			if (!full || !belongsToRequest(request, String(full[SUPPLY_REQUEST_KEY_FIELD] ?? ''))) continue;
			const rawItems = Array.isArray(full?.['items']) ? full['items'] as Array<Record<string, unknown>> : [];
			const child: PurchaseReceiptChild = {
				name: String(h['name'] ?? ''),
				status: String(h['status'] ?? ''),
				purchaseOrder: String(h[SUPPLY_PURCHASE_ORDER_FIELD] ?? full?.[SUPPLY_PURCHASE_ORDER_FIELD] ?? ''),
				lines: rawItems
					.map((l) => ({ productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty: Number(l['qty'] ?? 0), rate: Number(l['rate'] ?? 0), warehouse: String(l['warehouse'] ?? '') }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
			};
			receipts.set(request.requestKey, [...(receipts.get(request.requestKey) ?? []), child]);
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
			const request = byName.get(requestName);
			if (!request) continue;
			const full = await erp.get<Record<string, unknown>>('Purchase Order', String(h['name']));
			if (!full || !belongsToRequest(request, String(full[SUPPLY_REQUEST_KEY_FIELD] ?? ''))) continue;
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
					.map((l) => {
						const qty = Number(l['qty'] ?? 0);
						const storedRequestQty = l[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
						return { productId: Number(l['item_code']), name: String(l['item_name'] ?? l['item_code'] ?? ''), qty, rate: Number(l['rate'] ?? 0), requestQty: storedRequestQty == null ? qty : Math.max(Number(storedRequestQty), 0) };
					})
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0),
				receipts: [],
			};
			out.set(request.requestKey, [...(out.get(request.requestKey) ?? []), child]);
		}
		for (const [requestName, rows] of receipts.entries()) {
			const purchases = out.get(requestName);
			if (purchases?.[0]) {
				const orphanRows: PurchaseReceiptChild[] = [];
				for (const receipt of rows) {
					const target = receipt.purchaseOrder ? purchases.find((purchase) => purchase.name === receipt.purchaseOrder) : null;
					if (target) target.receipts.push(receipt);
					else orphanRows.push(receipt);
				}
				if (orphanRows.length) purchases[0].receipts.push(...orphanRows);
			}
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

function purchaseRequestLines(lines: TransferLine[]): TransferLine[] {
	return lines
		.map((line) => ({ ...line, qty: Math.min(line.qty, line.requestQty ?? line.qty) }))
		.filter((line) => line.qty > 0);
}

function currentRequest(requests: SupplyRequest[], requestName: string, requestKey: string): SupplyRequest {
	const request = requests.find((item) => item.name === requestName);
	if (!request) throw new Error('заявка не найдена в ядре');
	if (requestKey && request.requestKey !== requestKey) throw new Error('заявка была пересоздана; обнови список и повтори действие');
	return request;
}

async function currentUser(client: B24Client): Promise<CurrentUser> {
	const me = await client.call<{ ID?: string | number; NAME?: string; LAST_NAME?: string }>('user.current', {}).catch(() => null);
	const id = String(me?.ID ?? '');
	return { id, name: `${me?.NAME ?? ''} ${me?.LAST_NAME ?? ''}`.trim() };
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
			const planned = new Map<string, Map<number, number>>();
			const fulfilled = new Map<string, Map<number, number>>();
			const transfersByRequest = new Map<string, TransferProgress[]>();
			try {
				await ensureTransfersEntity(client);
				const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
				for (const t of (transferItems ?? []).map(parseTransferProgress).filter((x): x is TransferProgress => x != null)) {
					const request = reqs.find((candidate) => transferBelongsToRequest(t, candidate));
					if (!request) continue;
					transfersByRequest.set(request.requestKey, [...(transfersByRequest.get(request.requestKey) ?? []), t]);
					if (t.status !== 'canceled') addCovered(planned, request.requestKey, t.lines);
					const lines = t.status === 'shortage' ? t.receivedLines : t.status === 'received' ? t.lines : [];
					addCovered(fulfilled, request.requestKey, lines);
				}
			} catch {
				// Если старое хранилище перемещений недоступно, заявки всё равно покажем как есть.
			}
			const purchasesByRequest = await listPurchaseChildren(erp, reqs);
			for (const [requestKey, purchases] of purchasesByRequest.entries()) {
				for (const purchase of purchases) {
					if (purchase.supplyStage !== 'cancelled') addCovered(planned, requestKey, purchaseRequestLines(purchase.lines));
				}
			}
			const enriched = reqs.map((o) => {
				const byProduct = planned.get(o.requestKey) ?? new Map<number, number>();
				const fulfilledByProduct = fulfilled.get(o.requestKey) ?? new Map<number, number>();
				const remaining = o.items
					.map((item) => ({ ...item, qty: Math.max(item.qty - (byProduct.get(item.productId) ?? 0), 0) }))
					.filter((item) => item.qty > 0);
				const unfulfilled = o.items
					.map((item) => ({ ...item, qty: Math.max(item.qty - (fulfilledByProduct.get(item.productId) ?? 0), 0) }))
					.filter((item) => item.qty > 0);
				const closedByProgress = o.items.length > 0 && unfulfilled.length === 0;
				return {
					...o,
					items: remaining,
					originalItems: o.items,
					transfers: transfersByRequest.get(o.requestKey) ?? [],
					purchases: purchasesByRequest.get(o.requestKey) ?? [],
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

	app.post('/api/supply/create-documents', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; toStore?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const toStore = String(b.toStore ?? '').trim();
		if (!toStore) return reply.code(400).send({ ok: false, error: 'bad toStore' });
		const lines: SupplyDecisionLine[] = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as Record<string, unknown>)
			.map((l) => ({
				productId: Number(l['productId']),
				itemName: String(l['itemName'] ?? ''),
				qty: Number(l['qty']),
				action: String(l['action'] ?? '') === 'transfer' ? 'transfer' as const : String(l['action'] ?? '') === 'purchase' ? 'purchase' as const : '' as never,
				fromStore: String(l['fromStore'] ?? '').trim(),
				supplier: String(l['supplier'] ?? '').trim(),
			}))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0 && (l.action === 'transfer' || l.action === 'purchase'));
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет строк для создания документов' });
		const badTransfer = lines.find((l) => l.action === 'transfer' && (!l.fromStore || l.fromStore === toStore));
		if (badTransfer) return reply.code(400).send({ ok: false, error: `для перемещения нужен другой склад-источник: ${badTransfer.itemName || badTransfer.productId}` });
		const badPurchase = lines.find((l) => l.action === 'purchase' && !l.supplier);
		if (badPurchase) return reply.code(400).send({ ok: false, error: `для закупки нужен поставщик: ${badPurchase.itemName || badPurchase.productId}` });
		const lockKey = `${normalizeDomain(b.domain ?? '')}:${requestKey || requestName}`;
		if (supplyCreationLocks.has(lockKey)) {
			return reply.code(200).send({ ok: false, error: 'Документы по этой заявке уже создаются. Дождись результата текущей операции.' });
		}
		supplyCreationLocks.add(lockKey);
		const createdTransfers: unknown[] = [];
		const createdPurchases: string[] = [];

		try {
			await ensureTransfersEntity(client);
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			if (request.toStore && request.toStore !== toStore) throw new Error(`склад назначения заявки изменился: ${request.toStore}`);

			const requested = new Map<number, number>();
			for (const item of request.items) requested.set(item.productId, (requested.get(item.productId) ?? 0) + item.qty);
			const planned = new Map<number, number>();
			const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			for (const transfer of (transferItems ?? []).map(parseTransferProgress).filter((item): item is TransferProgress => item != null)) {
				if (!transferBelongsToRequest(transfer, request) || transfer.status === 'canceled') continue;
				for (const line of transfer.lines) planned.set(line.productId, (planned.get(line.productId) ?? 0) + line.qty);
			}
			const existingPurchases = (await listPurchaseChildren(erp, [request])).get(request.requestKey) ?? [];
			for (const purchase of existingPurchases) {
				if (purchase.supplyStage === 'cancelled') continue;
				for (const line of purchase.lines) planned.set(line.productId, (planned.get(line.productId) ?? 0) + line.qty);
			}
			const incomingProducts = new Set(lines.map((line) => line.productId));
			const incomingTransfers = new Map<number, number>();
			for (const line of lines.filter((item) => item.action === 'transfer')) {
				incomingTransfers.set(line.productId, (incomingTransfers.get(line.productId) ?? 0) + line.qty);
			}
			for (const productId of incomingProducts) {
				const remaining = Math.max((requested.get(productId) ?? 0) - (planned.get(productId) ?? 0), 0);
				const title = lines.find((line) => line.productId === productId)?.itemName || `#${productId}`;
				if (remaining <= 0) throw new Error(`заявка уже изменилась: позиция «${title}» полностью распределена`);
				const transferQty = incomingTransfers.get(productId) ?? 0;
				if (transferQty > remaining + 0.0001) throw new Error(`для «${title}» осталось распределить ${remaining}, перемещением выбрано ${transferQty}`);
			}
			const transferByProductStore = new Map<string, number>();
			for (const line of lines.filter((item) => item.action === 'transfer')) {
				const key = `${line.productId}:${line.fromStore}`;
				transferByProductStore.set(key, (transferByProductStore.get(key) ?? 0) + line.qty);
			}
			for (const [key, qty] of transferByProductStore.entries()) {
				const separator = key.indexOf(':');
				const productId = Number(key.slice(0, separator));
				const fromStore = key.slice(separator + 1);
				const requestItem = request.items.find((item) => item.productId === productId);
				const available = Number(requestItem?.stocks?.[fromStore] ?? 0);
				if (qty > available + 0.0001) {
					throw new Error(`остаток изменился: на складе «${fromStore}» доступно ${available}, выбрано ${qty}`);
				}
			}

			const me = await currentUser(client);
			const now = new Date().toISOString();
			const scheduleDate = now.slice(0, 10);

			const purchasesBySupplier = new Map<string, SupplyDecisionLine[]>();
			for (const line of lines.filter((l) => l.action === 'purchase')) {
				purchasesBySupplier.set(line.supplier, [...(purchasesBySupplier.get(line.supplier) ?? []), line]);
			}
			for (const [supplier, supplierLines] of purchasesBySupplier.entries()) {
				await ensureB24SupplierCompany(client, supplier);
				const { name } = await createPurchaseOrderDraft(erp, {
					dealId,
					supplyRequest: requestName,
					supplyRequestKey: request.requestKey,
					scheduleDate,
					supplier,
					lines: supplierLines.map((l) => ({ productId: l.productId, itemName: l.itemName, qty: l.qty, rate: 0 })),
				});
				createdPurchases.push(name);
			}

			const transfersByStore = new Map<string, SupplyDecisionLine[]>();
			for (const line of lines.filter((l) => l.action === 'transfer')) {
				transfersByStore.set(line.fromStore, [...(transfersByStore.get(line.fromStore) ?? []), line]);
			}
			for (const [fromStore, storeLines] of transfersByStore.entries()) {
				const transferLines = storeLines.map((l) => ({ productId: l.productId, name: l.itemName || `#${l.productId}`, qty: l.qty }));
				const baseData = {
					supplyRequest: requestName,
					supplyRequestKey: request.requestKey,
					purchaseOrder: '',
					dealId: String(dealId),
					toStore,
					fromStore,
					status: 'requested',
					lines: transferLines,
					note: '',
					taskId: null,
					shipEntry: null,
					receiveEntry: null,
					receivedLines: [],
					shortageLines: [],
					shortageReturnEntry: null,
					createdAt: now,
					createdById: me.id,
					createdByName: me.name,
					history: [{ at: now, status: 'requested', byId: me.id, byName: me.name, note: 'создано из дисплея снабжения' }],
				};
				const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
				const added = await client.call<number | { id?: number }>('entity.item.add', {
					ENTITY: TRANSFERS_ENTITY,
					NAME: itemName,
					DETAIL_TEXT: JSON.stringify(baseData),
				});
				const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
				if (!id) throw new Error('entity.item.add не вернул id');
				const { name: shipEntry } = await shipTransferToTransit(erp, {
					dealId,
					supplyRequest: requestName,
					supplyRequestKey: request.requestKey,
					lines: transferLines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore })),
				});
				const shippedAt = new Date().toISOString();
				const shippedData = {
					...baseData,
					status: 'in_transit',
					shipEntry,
					history: [...baseData.history, { at: shippedAt, status: 'in_transit', byId: me.id, byName: me.name, note: `Stock Entry ${shipEntry}` }],
				};
				await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: itemName, DETAIL_TEXT: JSON.stringify(shippedData) });
				createdTransfers.push({ id, name: itemName, ...shippedData });
			}

			app.log.info({ requestName, dealId, transfers: createdTransfers.length, purchases: createdPurchases.length }, '[api/supply/create-documents] ok');
			return { ok: true, transfers: createdTransfers, purchases: createdPurchases };
		} catch (err) {
			app.log.error({ requestName, dealId }, `[api/supply/create-documents] failed — ${errInfo(err)}`);
			return reply.code(200).send({
				ok: false,
				error: errInfo(err),
				partial: createdTransfers.length > 0 || createdPurchases.length > 0,
				transfers: createdTransfers,
				purchases: createdPurchases,
			});
		} finally {
			supplyCreationLocks.delete(lockKey);
		}
	});

	app.post('/api/supply/suppliers', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		try {
			return { ok: true, suppliers: await fetchSupplierCompanies(client) };
		} catch (err) {
			app.log.error({}, `[api/supply/suppliers] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), suppliers: [] });
		}
	});

	app.post('/api/supply/purchase-order', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; supplier?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const supplier = String(b.supplier ?? '').trim();
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const scheduleDate = new Date().toISOString().slice(0, 10);
			if (supplier) await ensureB24SupplierCompany(client, supplier);
			const { name } = await createPurchaseOrderDraft(erp, { dealId, supplyRequest: requestName, supplyRequestKey: request.requestKey, scheduleDate, ...(supplier ? { supplier } : {}), lines });
			app.log.info({ dealId, requestName, supplier, lines: lines.length, name }, '[api/supply/purchase-order] created');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName }, `[api/supply/purchase-order] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown; supplier?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const supplier = String(b.supplier ?? '').trim();
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; itemName?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), itemName: String(l.itemName ?? ''), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций для закупки' });
		try {
			if (supplier) await ensureB24SupplierCompany(client, supplier);
			const { name } = await updatePurchaseOrderDraft(erp, { purchaseOrder, ...(supplier ? { supplier } : {}), lines });
			app.log.info({ purchaseOrder, supplier, lines: lines.length, name }, '[api/supply/purchase-order/update] updated');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ purchaseOrder }, `[api/supply/purchase-order/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-order/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { purchaseOrder?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const me = await currentUser(client);
		if (!SUPPLY_DOCUMENT_DELETE_IDS.has(me.id)) return reply.code(403).send({ ok: false, error: 'удаление документов недоступно' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		try {
			const order = await erp.get<Record<string, unknown>>('Purchase Order', purchaseOrder);
			if (!order) return { ok: true };
			if (!String(order[SUPPLY_REQUEST_FIELD] ?? '').trim()) {
				return reply.code(403).send({ ok: false, error: 'можно удалить только заявку поставщику, созданную из снабжения' });
			}
			const receipts = await erp.list<Record<string, unknown>>(
				'Purchase Receipt',
				['name', 'docstatus'],
				[[SUPPLY_PURCHASE_ORDER_FIELD, '=', purchaseOrder], ['docstatus', '!=', 2]],
			);
			for (const receipt of receipts) {
				const name = String(receipt['name'] ?? '');
				const docstatus = Number(receipt['docstatus'] ?? 0);
				if (!name) continue;
				if (docstatus === 1) await erp.cancel('Purchase Receipt', name);
				else if (docstatus === 0) await erp.delete('Purchase Receipt', name);
			}
			const docstatus = Number(order['docstatus'] ?? 0);
			if (docstatus === 1) await erp.cancel('Purchase Order', purchaseOrder);
			else if (docstatus === 0) await erp.delete('Purchase Order', purchaseOrder);
			app.log.info({ purchaseOrder, by: me.id, receipts: receipts.length }, '[api/supply/purchase-order/delete] removed');
			return { ok: true };
		} catch (err) {
			app.log.error({ purchaseOrder, by: me.id }, `[api/supply/purchase-order/delete] failed — ${errInfo(err)}`);
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
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; purchaseOrder?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const toStore = String(process.env['SUPPLY_RECEIPT_STORE'] ?? '').trim() || 'Склад Прихода';
		const lines = (Array.isArray(b.lines) ? b.lines : [])
			.map((l) => l as { productId?: unknown; qty?: unknown; rate?: unknown })
			.map((l) => ({ productId: Number(l.productId), qty: Number(l.qty), rate: Number(l.rate ?? 0) }))
			.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && Number.isFinite(l.qty) && l.qty > 0);
		if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет фактически полученных позиций' });
		try {
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const { name } = await createSupplyPurchaseReceipt(erp, { dealId, supplyRequest: requestName, supplyRequestKey: request.requestKey, purchaseOrder, toStore, lines });
			app.log.info({ dealId, requestName, purchaseOrder, lines: lines.length, name }, '[api/supply/purchase-receive] received');
			return { ok: true, name };
		} catch (err) {
			app.log.error({ dealId, requestName, purchaseOrder }, `[api/supply/purchase-receive] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	app.post('/api/supply/purchase-transfer', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; requestName?: unknown; requestKey?: unknown; purchaseOrder?: unknown; lines?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const requestName = String(b.requestName ?? '').trim();
		if (!requestName) return reply.code(400).send({ ok: false, error: 'bad requestName' });
		const requestKey = String(b.requestKey ?? '').trim();
		const purchaseOrder = String(b.purchaseOrder ?? '').trim();
		if (!purchaseOrder) return reply.code(400).send({ ok: false, error: 'bad purchaseOrder' });
		const incoming = new Map<number, number>();
		for (const raw of Array.isArray(b.lines) ? b.lines as Array<Record<string, unknown>> : []) {
			const productId = Number(raw['productId']);
			const qty = Number(raw['qty']);
			if (Number.isInteger(productId) && productId > 0 && Number.isFinite(qty) && qty > 0) {
				incoming.set(productId, (incoming.get(productId) ?? 0) + qty);
			}
		}
		if (!incoming.size) return reply.code(400).send({ ok: false, error: 'нет позиций для перемещения' });
		const lockKey = `purchase-transfer:${normalizeDomain(b.domain ?? '')}:${purchaseOrder}`;
		if (supplyCreationLocks.has(lockKey)) return reply.code(200).send({ ok: false, error: 'перемещение по этому заказу уже создаётся' });
		supplyCreationLocks.add(lockKey);
		try {
			await ensureTransfersEntity(client);
			const request = currentRequest(await listSupplyRequests(erp), requestName, requestKey);
			if (Number(request.dealId) !== dealId) throw new Error('заявка больше не относится к этой сделке');
			const toStore = String(request.toStore ?? '').trim();
			if (!toStore) throw new Error('у заявки не указан склад точки');
			const fromStore = String(process.env['SUPPLY_RECEIPT_STORE'] ?? '').trim() || 'Склад Прихода';
			if (fromStore === toStore) throw new Error('склад прихода совпадает со складом точки');

			const order = await erp.get<Record<string, unknown>>('Purchase Order', purchaseOrder);
			if (!order) throw new Error('заказ поставщику не найден');
			if (String(order['b24_deal_id'] ?? '') !== String(dealId)) throw new Error('заказ поставщику не относится к этой сделке');
			if (String(order[SUPPLY_REQUEST_FIELD] ?? '') !== requestName) throw new Error('заказ поставщику не относится к этой заявке');
			const orderRequestKey = String(order[SUPPLY_REQUEST_KEY_FIELD] ?? '');
			if (orderRequestKey && orderRequestKey !== request.requestKey) throw new Error('заказ поставщику относится к другой версии заявки');
			const itemNames = new Map<number, string>();
			const allocated = new Map<number, number>();
			for (const line of Array.isArray(order['items']) ? order['items'] as Array<Record<string, unknown>> : []) {
				const productId = Number(line['item_code']);
				if (Number.isInteger(productId) && productId > 0) {
					itemNames.set(productId, String(line['item_name'] ?? line['item_code'] ?? ''));
					const qty = Number(line['qty'] ?? 0);
					const storedRequestQty = line[SUPPLY_PURCHASE_REQUEST_QTY_FIELD];
					const requestQty = storedRequestQty == null ? qty : Math.max(Number(storedRequestQty), 0);
					allocated.set(productId, (allocated.get(productId) ?? 0) + Math.min(qty, requestQty));
				}
			}

			const received = new Map<number, number>();
			const receiptHeaders = await erp.list<Record<string, unknown>>(
				'Purchase Receipt',
				['name'],
				[[SUPPLY_PURCHASE_ORDER_FIELD, '=', purchaseOrder], ['docstatus', '=', 1]],
			);
			for (const header of receiptHeaders) {
				const receipt = await erp.get<Record<string, unknown>>('Purchase Receipt', String(header['name'] ?? ''));
				for (const line of Array.isArray(receipt?.['items']) ? receipt.items as Array<Record<string, unknown>> : []) {
					const productId = Number(line['item_code']);
					if (Number.isInteger(productId) && productId > 0) received.set(productId, (received.get(productId) ?? 0) + Number(line['qty'] ?? 0));
				}
			}

			const requested = new Map<number, number>();
			for (const line of request.items) requested.set(line.productId, (requested.get(line.productId) ?? 0) + line.qty);
			const covered = new Map<number, number>();
			const forwarded = new Map<number, number>();
			const transferItems = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } });
			for (const transfer of (transferItems ?? []).map(parseTransferProgress).filter((item): item is TransferProgress => item != null)) {
				if (!transferBelongsToRequest(transfer, request) || transfer.status === 'canceled') continue;
				for (const line of transfer.lines) {
					covered.set(line.productId, (covered.get(line.productId) ?? 0) + line.qty);
					if (transfer.purchaseOrder === purchaseOrder) forwarded.set(line.productId, (forwarded.get(line.productId) ?? 0) + line.qty);
				}
			}
			for (const [productId, qty] of incoming.entries()) {
				const available = Math.max((received.get(productId) ?? 0) - (forwarded.get(productId) ?? 0), 0);
				const needed = Math.max((requested.get(productId) ?? 0) - (covered.get(productId) ?? 0), 0);
				const allocatedRemaining = Math.max((allocated.get(productId) ?? 0) - (forwarded.get(productId) ?? 0), 0);
				const title = itemNames.get(productId) || `#${productId}`;
				if (qty > available + 0.000001) throw new Error(`для «${title}» оприходовано и ещё не перемещено ${available}, указано ${qty}`);
				if (qty > needed + 0.000001) throw new Error(`для точки по «${title}» осталось получить ${needed}, указано ${qty}`);
				if (qty > allocatedRemaining + 0.000001) throw new Error(`из этой заявки поставщику для «${title}» к перемещению по исходной заявке осталось ${allocatedRemaining}, указано ${qty}`);
			}

			const me = await currentUser(client);
			const now = new Date().toISOString();
			const transferLines = [...incoming.entries()].map(([productId, qty]) => ({ productId, name: itemNames.get(productId) || `#${productId}`, qty }));
			const baseData = {
				supplyRequest: requestName,
				supplyRequestKey: request.requestKey,
				purchaseOrder,
				dealId: String(dealId),
				toStore,
				fromStore,
				status: 'requested',
				lines: transferLines,
				note: '',
				taskId: null,
				shipEntry: null,
				receiveEntry: null,
				receivedLines: [],
				shortageLines: [],
				shortageReturnEntry: null,
				createdAt: now,
				createdById: me.id,
				createdByName: me.name,
				history: [{ at: now, status: 'requested', byId: me.id, byName: me.name, note: `создано после оприходования ${purchaseOrder}` }],
			};
			const itemName = `Перемещение #${dealId}: ${fromStore} → ${toStore}`;
			const added = await client.call<number | { id?: number }>('entity.item.add', {
				ENTITY: TRANSFERS_ENTITY,
				NAME: itemName,
				DETAIL_TEXT: JSON.stringify(baseData),
			});
			const id = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
			if (!id) throw new Error('entity.item.add не вернул id');
			const { name: shipEntry } = await shipTransferToTransit(erp, {
				dealId,
				supplyRequest: requestName,
				supplyRequestKey: request.requestKey,
				purchaseOrder,
				lines: transferLines.map((line) => ({ productId: line.productId, qty: line.qty, fromStore })),
			});
			const shippedAt = new Date().toISOString();
			const shippedData = {
				...baseData,
				status: 'in_transit',
				shipEntry,
				history: [...baseData.history, { at: shippedAt, status: 'in_transit', byId: me.id, byName: me.name, note: `Stock Entry ${shipEntry}` }],
			};
			await client.call('entity.item.update', { ENTITY: TRANSFERS_ENTITY, ID: id, NAME: itemName, DETAIL_TEXT: JSON.stringify(shippedData) });
			app.log.info({ requestName, purchaseOrder, id, shipEntry }, '[api/supply/purchase-transfer] created');
			return { ok: true, transfer: { id, name: itemName, ...shippedData } };
		} catch (err) {
			app.log.error({ requestName, purchaseOrder }, `[api/supply/purchase-transfer] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			supplyCreationLocks.delete(lockKey);
		}
	});
}
