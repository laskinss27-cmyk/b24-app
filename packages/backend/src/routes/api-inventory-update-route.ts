import type { FastifyInstance } from 'fastify';
import { ensureInventoryEntity } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import { coreStoreId, fetchErpStoreStockFull, listActiveStoreTitles } from '../erp/operations.js';
import { captureInventoryPointSnapshots, inventorySnapshotQuantities, inventoryCountQuantities, isConfirmedInventoryRecount, normalizeInventorySubmission } from '../inventory-stock-snapshot.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import { synchronizeInventoryStatus } from './api-inventory-status.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';
import { loadInventoryItems, updateInventoryData } from './inventory-storage.js';
import { inventoryDraftSaveDecision } from './inventory-draft-save-guard.js';
import { priceInventoryResult } from '../inventory-retail-prices.js';

export function registerInventoryUpdateRoute(app: FastifyInstance): void {
	app.post('/api/inventory/update', async (req, reply) => {
		const b = (req.body ?? {}) as InventoryAuthBody & {
			inventoryId?: string;
			storeId?: number;
			action?: 'claim' | 'saveDraft' | 'submit' | 'makeAct' | 'reopen';
			userId?: string;
			userName?: string;
			draft?: Record<string, number>;
			comments?: Record<string, unknown>;
			facts?: Record<string, number>;
			result?: unknown;
			draftSessionId?: string;
			draftSequence?: number;
		};
		const client = inventoryClientFrom(app, b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId || b.storeId == null || !b.action) {
			return reply.code(400).send({ ok: false, error: 'inventoryId/storeId/action required' });
		}

		await ensureInventoryEntity(client);
		return withInventoryUpdateLock(b.inventoryId, async () => {
			try {
				const items = await loadInventoryItems(app, client, 'update');
				const item = (items ?? []).find((it) => String(it['ID']) === String(b.inventoryId));
				if (!item) return reply.code(200).send({ ok: false, error: 'инвентаризация не найдена' });

				let data: Record<string, unknown> = {};
				try {
					data = item['DETAIL_TEXT'] ? (JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>) : {};
				} catch {
					return reply.code(200).send({ ok: false, error: 'битый JSON хранилища' });
				}
				const points = Array.isArray(data['points']) ? (data['points'] as Array<Record<string, unknown>>) : [];
				let pt = points.find((p) => Number(p['storeId']) === Number(b.storeId));
				if (!pt) return reply.code(200).send({ ok: false, error: 'точка не найдена' });

				const status = String(pt['status'] ?? 'idle');
				const now = new Date().toISOString();
				const meId = String(b.userId ?? '');
				const comments = b.comments && typeof b.comments === 'object'
					? Object.fromEntries(Object.entries(b.comments)
						.filter(([productId, value]) => /^\d+$/.test(productId) && Number(productId) > 0 && typeof value === 'string')
						.slice(0, 2000)
						.map(([productId, value]) => [productId, String(value).trim().slice(0, 500)])
						.filter(([, value]) => Boolean(value)))
					: null;
				if (b.action === 'saveDraft') {
					const decision = inventoryDraftSaveDecision(pt, b, comments, data['status']);
					if (decision.kind === 'reject') {
						app.log.warn({ inventoryId: b.inventoryId, storeId: b.storeId, code: decision.code }, '[inventory/draft] rejected');
						return { ok: false, error: decision.error, code: decision.code };
					}
					if (decision.kind === 'already_saved') {
						return { ok: true, draftSaved: true, alreadySaved: true, draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
					}
				}
				if (isConfirmedInventoryRecount(pt)) throw new Error('Фактическое наличие этой ревизии уже отдельно подтверждено с учётом движений. Обычное редактирование запрещено, чтобы не потерять базу пересчёта. Для новых чисел нужен повторный подтверждённый пересчёт.');
				// Active inventories created before snapshot support are frozen on their next write.
				// Submitted history remains untouched and keeps the legacy reconciliation path.
				if ((b.action === 'claim' || b.action === 'saveDraft') && !inventorySnapshotQuantities(pt)) {
					const erp = ErpClient.fromEnv();
					if (!erp) throw new Error('ядро склада не подключено — снимок остатков не создан');
					const storeTitles = await listActiveStoreTitles(erp);
					const [frozenPoint] = await captureInventoryPointSnapshots([pt], now, {
						storeTitles,
						storeIdForTitle: coreStoreId,
						loadStock: (storeTitle) => fetchErpStoreStockFull(erp, storeTitle),
					});
					if (!frozenPoint) throw new Error('не удалось зафиксировать снимок остатков');
					frozenPoint['stockSnapshotMigratedAt'] = now;
					const pointIndex = points.indexOf(pt);
					points[pointIndex] = frozenPoint;
					pt = frozenPoint;
					app.log.info({ inventoryId: b.inventoryId, storeId: b.storeId }, '[api/inventory/update] legacy stock snapshot captured');
				}

				if (b.action === 'claim') {
					if (status === 'submitted') return reply.code(200).send({ ok: false, error: 'точка уже отправлена' });
					pt['responsibleId'] = meId;
					pt['responsibleName'] = String(b.userName ?? '');
					pt['status'] = 'in_progress';
					pt['startedAt'] = now;
				} else if (b.action === 'saveDraft') {
					const sessionId = String(b.draftSessionId ?? '').trim().slice(0, 80);
					const sequence = Number(b.draftSequence ?? 0);
					pt['draft'] = b.draft ?? {};
					if (comments) pt['comments'] = comments;
					pt['draftUpdatedAt'] = now;
					pt['draftUpdatedById'] = meId;
					pt['draftUpdatedByName'] = String(b.userName ?? '');
					if (sessionId && Number.isInteger(sequence) && sequence > 0) {
						pt['draftSessionId'] = sessionId;
						pt['draftSequence'] = sequence;
					}
					if (status === 'idle') {
						pt['status'] = 'in_progress';
						if (!pt['responsibleId']) {
							pt['responsibleId'] = meId;
							pt['responsibleName'] = String(b.userName ?? '');
						}
						pt['startedAt'] = pt['startedAt'] ?? now;
					}
				} else if (b.action === 'submit') {
					if (status === 'submitted' || status === 'reconciled') {
						return { ok: false, error: 'Отчёт уже отправлен. Для изменения верните точку в работу.' };
					}
					const previousResult = pt['result'] && typeof pt['result'] === 'object'
						? pt['result'] as Record<string, unknown>
						: {};
					const previousLines = Array.isArray(previousResult['lines']) ? previousResult['lines'].length : 0;
					const previousCounted = Number(previousResult['counted']);
					const actBaseline = status === 'act' && Number.isFinite(previousCounted)
						? Math.max(0, previousCounted - previousLines)
						: 0;
					const submitted = normalizeInventorySubmission(
						b.result,
						b.facts,
						inventoryCountQuantities(pt),
						actBaseline,
					);
					pt['status'] = status === 'act' ? 'reconciled' : 'submitted';
					pt['submittedAt'] = now;
					// Only explicitly entered facts are compared with the immutable opening snapshot.
					// Blank rows are uncounted and therefore never create warehouse movements.
					if (submitted.result.lines.length) {
						const erp = ErpClient.fromEnv();
						if (!erp) throw new Error('Не удалось загрузить розничные цены. Отчёт не отправлен, повторите отправку позже.');
						pt['result'] = await priceInventoryResult(erp, submitted.result);
					} else pt['result'] = submitted.result;
					pt['draft'] = submitted.facts;
					if (comments) pt['comments'] = comments;
					if (!pt['responsibleId']) {
						pt['responsibleId'] = meId;
						pt['responsibleName'] = String(b.userName ?? '');
					}
				} else if (b.action === 'makeAct') {
					if (status !== 'submitted') return reply.code(200).send({ ok: false, error: 'акт формируется только по отправленной точке' });
					pt['status'] = 'act';
					pt['actAt'] = now;
				} else if (b.action === 'reopen') {
					if (status === 'idle' || status === 'in_progress') return reply.code(200).send({ ok: false, error: 'точка уже в работе' });
					pt['status'] = 'in_progress';
					delete pt['submittedAt'];
					delete pt['actAt'];
				} else {
					return reply.code(400).send({ ok: false, error: `неизвестное действие ${String(b.action)}` });
				}

				data['points'] = points;
				synchronizeInventoryStatus(data, points);
				await updateInventoryData(app, client, {
					id: b.inventoryId!,
					name: item['NAME'],
					data,
					sourceItem: item,
				});
				app.log.info({ action: b.action, inventoryId: b.inventoryId, storeId: b.storeId }, '[api/inventory/update] ok');
				return { ok: true, ...(b.action === 'saveDraft' ? { draftSaved: true } : {}), ...(b.action === 'submit' ? { result: pt['result'] } : {}), draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
			} catch (err) {
				app.log.error({ action: b.action, inventoryId: b.inventoryId, storeId: b.storeId }, `[api/inventory/update] failed — ${inventoryErrorInfo(err)}`);
				return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
			}
		});
	});
}
