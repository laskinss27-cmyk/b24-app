import type { FastifyInstance } from 'fastify';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { inventoryClientFrom, inventoryErrorInfo } from './api-inventory-route-helpers.js';
import type { InventoryAuthBody } from './api-inventory-types.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';

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
				const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY });
				const item = (items ?? []).find((it) => String(it['ID']) === String(b.inventoryId));
				if (!item) return reply.code(200).send({ ok: false, error: 'инвентаризация не найдена' });

				let data: Record<string, unknown> = {};
				try {
					data = item['DETAIL_TEXT'] ? (JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>) : {};
				} catch {
					return reply.code(200).send({ ok: false, error: 'битый JSON хранилища' });
				}
				const points = Array.isArray(data['points']) ? (data['points'] as Array<Record<string, unknown>>) : [];
				const pt = points.find((p) => Number(p['storeId']) === Number(b.storeId));
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

				if (b.action === 'claim') {
					if (status === 'submitted') return reply.code(200).send({ ok: false, error: 'точка уже отправлена' });
					pt['responsibleId'] = meId;
					pt['responsibleName'] = String(b.userName ?? '');
					pt['status'] = 'in_progress';
					pt['startedAt'] = now;
				} else if (b.action === 'saveDraft') {
					const sessionId = String(b.draftSessionId ?? '').trim().slice(0, 80);
					const sequence = Number(b.draftSequence ?? 0);
					const storedSessionId = String(pt['draftSessionId'] ?? '');
					const storedSequence = Number(pt['draftSequence'] ?? 0);
					if (sessionId && sessionId === storedSessionId && Number.isInteger(sequence) && sequence <= storedSequence) {
						return { ok: true, ignored: true, draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
					}
					if (status === 'submitted' || status === 'reconciled') {
						return { ok: true, ignored: true, draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
					}
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
					pt['status'] = status === 'act' ? 'reconciled' : 'submitted';
					pt['submittedAt'] = now;
					pt['result'] = b.result ?? null;
					if (b.facts && typeof b.facts === 'object') pt['draft'] = b.facts;
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
				await client.call('entity.item.update', {
					ENTITY: INVENTORY_ENTITY,
					ID: b.inventoryId,
					NAME: item['NAME'],
					DETAIL_TEXT: JSON.stringify(data),
				});
				app.log.info({ action: b.action, storeId: b.storeId }, '[api/inventory/update] ok');
				return { ok: true, draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
			} catch (err) {
				app.log.error({ action: b.action }, `[api/inventory/update] failed — ${inventoryErrorInfo(err)}`);
				return reply.code(200).send({ ok: false, error: inventoryErrorInfo(err) });
			}
		});
	});
}
