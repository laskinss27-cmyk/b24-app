import type { FastifyInstance } from 'fastify';
import { ErpClient } from '../erp/client.js';
import {
	assertInventoryReceiptValuations,
	createInventoryAdjustmentDraft,
	createInventoryRecoDraft,
	deleteInventoryAdjustmentDraft,
	deleteInventoryRecoDraft,
	submitInventoryReco,
	type InventoryAdjustmentLine,
	type InventoryRecoLine,
} from '../erp/operations.js';
import {
	inventoryDocumentCount,
	inventoryDocumentSet,
	legacyInventoryDocument,
	type InventoryDocumentRecord,
	type InventoryDocumentSet,
} from './api-inventory-document-state.js';
import { submitInventoryDocumentSet } from './api-inventory-document-submission.js';
import { computeInventoryReconciliationLines, loadInventoryPoint } from './api-inventory-reconciliation-helpers.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import { synchronizeInventoryStatus } from './api-inventory-status.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';
import { ReservationService } from '../reservations/service.js';
import { updateInventoryData } from './inventory-storage.js';
import { checkInventoryDocuments } from './inventory-document-freshness.js';
import { checkInventoryStock } from './inventory-stock-check.js';

function draftRecord(name: string, lines: number, savedAt: string): InventoryDocumentRecord {
	return { name, status: 'draft', lines, savedAt };
}

async function updateInventoryItem(
	app: FastifyInstance,
	client: ReturnType<typeof inventoryClientFrom> & {},
	loaded: Awaited<ReturnType<typeof loadInventoryPoint>>,
): Promise<void> {
	loaded.data['points'] = loaded.points;
	await updateInventoryData(app, client, {
		id: String(loaded.item['ID']),
		name: loaded.item['NAME'],
		data: loaded.data,
		sourceItem: loaded.item,
	});
}

async function deleteDraftDocuments(erp: ErpClient, documents: InventoryDocumentSet): Promise<void> {
	for (const document of Object.values(documents)) {
		if (document?.status === 'draft') await deleteInventoryAdjustmentDraft(erp, document.name);
	}
}

export function registerInventoryReconciliationRoutes(app: FastifyInstance): void {
	app.post('/api/inventory/erp-doc-preview', async (req, reply) => {
		const body = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number };
		const client = inventoryClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!body.inventoryId || body.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const { pt } = await loadInventoryPoint(app, client, body.inventoryId, Number(body.storeId));
			if (String(pt['status']) !== 'reconciled') return reply.code(200).send({ ok: false, error: 'документы ядра — только по сверенной точке' });
			const { lines, storeName } = await computeInventoryReconciliationLines(erp, pt);
			const documentCheck = await checkInventoryDocuments(erp, pt, lines);
			const stockCheck = documentCheck.blocked ? undefined : await checkInventoryStock(erp, pt, lines);
			app.log.info({ storeId: body.storeId, lines: lines.length }, '[api/inventory/erp-doc-preview] ok');
			return {
				ok: true,
				lines,
				documentCheck,
				stockCheck,
				storeName,
				docs: inventoryDocumentSet(pt),
				legacyDoc: legacyInventoryDocument(pt) ?? null,
				// Старый клиент ожидает поле doc; сохраняем его на время совместимости.
				doc: legacyInventoryDocument(pt) ?? null,
			};
		} catch (error) {
			app.log.error({ storeId: body.storeId }, `[api/inventory/erp-doc-preview] failed — ${inventoryErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(error) });
		}
	});

	app.post('/api/inventory/erp-doc-save', async (req, reply) => {
		const body = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number; recreate?: boolean };
		const client = inventoryClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!body.inventoryId || body.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const saved = await withInventoryUpdateLock(body.inventoryId, async () => {
				const loaded = await loadInventoryPoint(app, client, body.inventoryId!, Number(body.storeId));
				if (String(loaded.pt['status']) !== 'reconciled') throw new Error('документы ядра — только по сверенной точке');
				// Compute first. A failed calculation must never delete existing drafts.
				const calculated = await computeInventoryReconciliationLines(erp, loaded.pt);
				const check = await checkInventoryDocuments(erp, loaded.pt, calculated.lines);
				if (body.recreate && !check.canRecreate && (legacyInventoryDocument(loaded.pt) || inventoryDocumentCount(inventoryDocumentSet(loaded.pt)))) throw new Error(check.message ?? 'Пересоздание запрещено: проверьте статусы документов в ядре.');
				if (!calculated.lines.length && body.recreate) {
					const oldLegacy = legacyInventoryDocument(loaded.pt);
					if (oldLegacy) await deleteInventoryRecoDraft(erp, oldLegacy.name);
					await deleteDraftDocuments(erp, inventoryDocumentSet(loaded.pt));
					delete loaded.pt['erpDoc']; delete loaded.pt['erpDocs'];
					synchronizeInventoryStatus(loaded.data, loaded.points);
					await updateInventoryItem(app, client, loaded);
					return { docs: {}, legacyDoc: null, lines: 0 };
				}
				if (!calculated.lines.length) throw new Error('В отчёте нет расхождений — документы не нужны. Для удаления прежних черновиков используйте пересоздание.');

				const legacy = legacyInventoryDocument(loaded.pt);
				if (legacy) {
					if (legacy.status === 'submitted') throw new Error(`документ ${legacy.name} уже проведён`);
					if (!body.recreate) throw new Error(`черновик ${legacy.name} уже записан (recreate — пересоздать)`);
					const { lines, storeName } = calculated;
					const recoLines: InventoryRecoLine[] = lines.map((line) => ({
						productId: line.productId,
						qty: line.fact,
						// Цена обязательна только для излишка; недостача идёт с текущей valuation склада (в т.ч. нулевой).
						valuation: line.diff > 0 ? line.inventoryRate : line.valuation,
						requiresPrice: line.diff > 0,
					}));
					// Проверка цены ДО удаления старого черновика и любых записей в ядро:
					// при ошибке прежний документ сохраняется.
					assertInventoryReceiptValuations(recoLines);
					await deleteInventoryRecoDraft(erp, legacy.name);
					const created = await createInventoryRecoDraft(erp, {
						invRef: `inv${body.inventoryId}:store${body.storeId}`,
						storeTitle: storeName,
						lines: recoLines,
					});
					const legacyDoc = draftRecord(created.name, lines.length, new Date().toISOString());
					loaded.pt['erpDoc'] = legacyDoc;
					await updateInventoryItem(app, client, loaded);
					return { docs: {}, legacyDoc, lines: lines.length };
				}

				const { lines, storeName } = calculated;
				const issueLines: InventoryAdjustmentLine[] = lines
					.filter((line) => line.diff < 0)
					.map((line) => ({ productId: line.productId, qty: Math.abs(line.diff), valuation: line.valuation }));
				const receiptLines: InventoryAdjustmentLine[] = lines
					.filter((line) => line.diff > 0)
					.map((line) => ({ productId: line.productId, qty: line.diff, valuation: line.inventoryRate }));
				if (!issueLines.length && !receiptLines.length) throw new Error('нет расхождений — документы не нужны');

				// Оприходование без цены блокируем до удаления прежних черновиков и до
				// любых записей в ядро: проверка — всегда, а не только при пересоздании.
				assertInventoryReceiptValuations(receiptLines);

				const previous = inventoryDocumentSet(loaded.pt);
				if (inventoryDocumentCount(previous)) {
					if (Object.values(previous).some((document) => document?.status === 'submitted')) {
						throw new Error('один из документов уже проведён — пересоздание запрещено');
					}
					if (!body.recreate) {
						const names = Object.values(previous).map((document) => document?.name).filter(Boolean).join(', ');
						throw new Error(`черновики уже записаны: ${names} (recreate — пересоздать)`);
					}
					await deleteDraftDocuments(erp, previous);
				}

				const createdNames: string[] = [];
				const documents: InventoryDocumentSet = {};
				const savedAt = new Date().toISOString();
				try {
					if (issueLines.length) {
						const created = await createInventoryAdjustmentDraft(erp, {
							invRef: `inv${body.inventoryId}:store${body.storeId}:issue`,
							kind: 'issue', storeTitle: storeName, lines: issueLines,
						});
						createdNames.push(created.name);
						documents.issue = draftRecord(created.name, issueLines.length, savedAt);
					}
					if (receiptLines.length) {
						const created = await createInventoryAdjustmentDraft(erp, {
							invRef: `inv${body.inventoryId}:store${body.storeId}:receipt`,
							kind: 'receipt', storeTitle: storeName, lines: receiptLines,
						});
						createdNames.push(created.name);
						documents.receipt = draftRecord(created.name, receiptLines.length, savedAt);
					}
					loaded.pt['erpDocs'] = documents;
					await updateInventoryItem(app, client, loaded);
				} catch (error) {
					for (const name of createdNames) await deleteInventoryAdjustmentDraft(erp, name).catch(() => undefined);
					throw error;
				}
				return { docs: documents, legacyDoc: null, lines: lines.length };
			});
			app.log.info({ storeId: body.storeId, documents: inventoryDocumentCount(saved.docs), lines: saved.lines }, '[api/inventory/erp-doc-save] ok');
			return { ok: true, ...saved, doc: saved.legacyDoc };
		} catch (error) {
			app.log.error({ storeId: body.storeId }, `[api/inventory/erp-doc-save] failed — ${inventoryErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(error) });
		}
	});

	app.post('/api/inventory/erp-doc-submit', async (req, reply) => {
		const body = (req.body ?? {}) as InventoryAuthBody & { inventoryId?: string; storeId?: number };
		const client = inventoryClientFrom(app, body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!body.inventoryId || body.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
		try {
			const pointBeforeSubmit = await loadInventoryPoint(app, client, body.inventoryId, Number(body.storeId));
			const storeTitle = String(pointBeforeSubmit.pt['storeName'] ?? pointBeforeSubmit.pt['store'] ?? '').trim();
			const completed = await withInventoryUpdateLock(body.inventoryId, async () => {
				const loaded = await loadInventoryPoint(app, client, body.inventoryId!, Number(body.storeId));
				if (String(loaded.pt['status']) !== 'reconciled') throw new Error('Ревизия ещё не сверена. Завершите подсчёт и проверку отчёта; проведение прежних документов запрещено.');
				const { lines } = await computeInventoryReconciliationLines(erp, loaded.pt);
				const check = await checkInventoryDocuments(erp, loaded.pt, lines);
				if (check.blocked) throw new Error(check.message!);
				const stockCheck = await checkInventoryStock(erp, loaded.pt, lines);
				if (stockCheck.blocked) return { ok: false as const, error: stockCheck.message!, stockCheck };
				const legacy = legacyInventoryDocument(loaded.pt);
				if (legacy) {
					const live = await erp.get('Stock Reconciliation', legacy.name);
					if (!live) throw new Error(`${legacy.name} не найден в ядре — пересоздай через «Записать»`);
					if (Number(live['docstatus'] ?? 0) !== 1) await submitInventoryReco(erp, legacy.name);
					legacy.status = 'submitted';
					legacy.submittedAt = new Date().toISOString();
					loaded.pt['erpDoc'] = legacy;
					const inventoryStatus = synchronizeInventoryStatus(loaded.data, loaded.points);
					await updateInventoryItem(app, client, loaded);
					return { docs: {}, legacyDoc: legacy, inventoryStatus };
				}

				const documents = inventoryDocumentSet(loaded.pt);
				if (!inventoryDocumentCount(documents)) throw new Error('сначала «Записать» (черновиков ядра нет)');
				await submitInventoryDocumentSet(erp, documents, async (currentDocuments) => {
					loaded.pt['erpDocs'] = currentDocuments;
					// Сохраняем каждый успешный шаг: при ошибке второго документа повтор продолжит с него.
					synchronizeInventoryStatus(loaded.data, loaded.points);
						await updateInventoryItem(app, client, loaded);
				});
				const inventoryStatus = synchronizeInventoryStatus(loaded.data, loaded.points);
				await updateInventoryItem(app, client, loaded);
				return { docs: documents, legacyDoc: null, inventoryStatus };
			});
			if ('ok' in completed && completed.ok === false) return completed;
			if (storeTitle && app.reservationRuntime?.canWrite) {
				await new ReservationService(app.reservationRuntime).reconcileStore(erp, storeTitle)
					.catch((error) => app.log.error({ inventoryId: body.inventoryId, storeId: body.storeId }, `[reservations] inventory submitted; reconcile required — ${inventoryErrorInfo(error)}`));
			}
			app.log.info({ storeId: body.storeId, documents: inventoryDocumentCount(completed.docs), inventoryStatus: completed.inventoryStatus }, '[api/inventory/erp-doc-submit] ok');
			return { ok: true, ...completed, doc: completed.legacyDoc };
		} catch (error) {
			app.log.error({ storeId: body.storeId }, `[api/inventory/erp-doc-submit] failed — ${inventoryErrorInfo(error)}`);
			return reply.code(200).send({ ok: false, error: inventoryErrorInfo(error) });
		}
	});
}
