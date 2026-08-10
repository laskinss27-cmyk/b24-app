import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import {
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	fetchErpItemNames,
	fetchErpStoreStock,
	submitInventoryReco,
	type InventoryRecoLine,
} from '../erp/operations.js';
import { registerInventoryCreateRoute } from './api-inventory-create-route.js';
import { inventoryClientFrom, inventoryErrorInfo as errInfo } from './api-inventory-route-helpers.js';
import { registerInventoryReadRoutes } from './api-inventory-read-routes.js';
import type { InventoryAuthBody as AuthBody } from './api-inventory-types.js';
import { withInventoryUpdateLock } from './api-inventory-update-lock.js';

export { withInventoryUpdateLock } from './api-inventory-update-lock.js';

/**
 * API инвентаризации для фронта. Фронтовый BX24 ВИСНЕТ на entity.* — поэтому
 * все операции с хранилищем (entity) делаем здесь, серверным B24Client (чистый
 * JSON, app-контекст). Фронт шлёт сюда свой BX24-токен (BX24.getAuth) + домен.
 *
 * Эндпоинты read/write только в нашей сущности ctv_inv; токен — самого юзера,
 * поэтому права Битрикса соблюдаются. Домен сверяем с порталом (allowlist).
 */
/**
 * ctv_inv хранит все точки одной инвентаризации в одной JSON-записи. Поэтому
 * параллельные read-modify-write двух складов обязаны идти последовательно,
 * иначе более поздний entity.item.update может вернуть старую версию соседней точки.
 * Production работает одним backend-контейнером, так что очередь на процесс надёжно
 * закрывает конкурентные автосохранения внутри текущей архитектуры хранения.
 */
export function registerApiInventoryRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => inventoryClientFrom(app, body);
	registerInventoryReadRoutes(app);
	registerInventoryCreateRoute(app);

	// Обновить ОДНУ точку инвентаризации: claim / saveDraft / submit.
	// Read-modify-write: перечитываем свежий элемент и мержим ТОЛЬКО свою точку (по storeId),
	// а очередь withInventoryUpdateLock последовательно проводит изменения разных точек одной записи.
	app.post('/api/inventory/update', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & {
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
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId || b.storeId == null || !b.action) {
			return reply.code(400).send({ ok: false, error: 'inventoryId/storeId/action required' });
		}

		await ensureInventoryEntity(client);
		return withInventoryUpdateLock(b.inventoryId, async () => {
		try {
			// read: берём свежий элемент (инвентаризаций единицы — выбираем по ID из общего списка)
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
				// БЕЗ блокировки по ответственному: считать может кто угодно (правило Сергея).
				// «Начал выполнение» делает текущего юзера ответственным (для отображения), но
				// не запрещает другим — назначение лишь для уведомления, не замок.
				pt['responsibleId'] = meId;
				pt['responsibleName'] = String(b.userName ?? '');
				pt['status'] = 'in_progress';
				pt['startedAt'] = now;
			} else if (b.action === 'saveDraft') {
				const sessionId = String(b.draftSessionId ?? '').trim().slice(0, 80);
				const sequence = Number(b.draftSequence ?? 0);
				const storedSessionId = String(pt['draftSessionId'] ?? '');
				const storedSequence = Number(pt['draftSequence'] ?? 0);
				// pagehide/keepalive может догнать более свежий запрос. В пределах одного
				// открытия формы старый пакет никогда не должен затереть новый.
				if (sessionId && sessionId === storedSessionId && Number.isInteger(sequence) && sequence <= storedSequence) {
					return { ok: true, ignored: true, draftUpdatedAt: pt['draftUpdatedAt'] ?? null };
				}
				// После отправки/сверки опоздавшее фоновое автосохранение уже не меняет точку.
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
				// submit из статуса «акт» (2-й раунд сверки) → «сверено»; иначе обычное «отправлено»
				pt['status'] = status === 'act' ? 'reconciled' : 'submitted';
				pt['submittedAt'] = now;
				pt['result'] = b.result ?? null;
				// факты раунда сохраняем (draft) — нужны, чтобы предзаполнить 2-й раунд (акт)
				if (b.facts && typeof b.facts === 'object') pt['draft'] = b.facts;
				if (comments) pt['comments'] = comments;
				if (!pt['responsibleId']) {
					pt['responsibleId'] = meId;
					pt['responsibleName'] = String(b.userName ?? '');
				}
			} else if (b.action === 'makeAct') {
				// инициатор формирует акт разногласий по отправленной точке → уходит менеджеру на сверку
				if (status !== 'submitted') return reply.code(200).send({ ok: false, error: 'акт формируется только по отправленной точке' });
				pt['status'] = 'act';
				pt['actAt'] = now;
			} else if (b.action === 'reopen') {
				// инициатор возвращает точку в работу для пересчёта; цифры (draft/result) сохраняем
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
			app.log.error({ action: b.action }, `[api/inventory/update] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
		});
	});

		// ── ДОКУМЕНТ ЯДРА (Stock Reconciliation, 1С-модель «на основании») ──────────
		// Болванка (preview, ничего не пишет) → «Записать» (черновик в ERPNext) →
		// «Провести» (submit ядра). Гейт: env ERPNEXT_URL.
		// Книга для документа ядра = остатки ЯДРА (факты выравнивают ERPNext, не Б24).

		/** Точка инвентаризации по id+storeId (свежее чтение entity). */
		const loadPoint = async (client: B24Client, inventoryId: string, storeId: number) => {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY });
			const item = (items ?? []).find((it) => String(it['ID']) === String(inventoryId));
			if (!item) throw new Error('инвентаризация не найдена');
			const data = item['DETAIL_TEXT'] ? (JSON.parse(String(item['DETAIL_TEXT'])) as Record<string, unknown>) : {};
			const points = Array.isArray(data['points']) ? (data['points'] as Array<Record<string, unknown>>) : [];
			const pt = points.find((p) => Number(p['storeId']) === Number(storeId));
			if (!pt) throw new Error('точка не найдена');
			return { item, data, points, pt };
		};

		/** Строки болванки: ВСЕ факты точки против книги ЯДРА (draft = полный набор фактов раунда). */
		const computeRecoLines = async (erp: ErpClient, pt: Record<string, unknown>) => {
			const facts = (pt['draft'] ?? {}) as Record<string, number>;
			const factIds = Object.keys(facts).map(Number).filter((n) => Number.isInteger(n) && n > 0);
			if (!factIds.length) throw new Error('у точки нет фактов подсчёта (draft пуст)');
			const storeName = String(pt['storeName'] ?? '');
			const book = await fetchErpStoreStock(erp, storeName);
			const resultLines = ((pt['result'] ?? {}) as { lines?: Array<{ productId: number; name?: string }> }).lines ?? [];
			const nameByid = new Map(resultLines.map((l) => [Number(l.productId), String(l.name ?? '')]));
			const lines: Array<{ productId: number; name: string; bookErp: number; fact: number; diff: number; valuation: number }> = [];
			for (const productId of factIds) {
				const fact = Number(facts[productId] ?? 0);
				const b = book.get(productId);
				const bookErp = b?.qty ?? 0;
				if (Math.abs(fact - bookErp) < 1e-9) continue;
				lines.push({ productId, name: nameByid.get(productId) ?? '', bookErp, fact, diff: fact - bookErp, valuation: b?.valuation ?? 0 });
			}
			const unnamed = lines.filter((l) => !l.name).map((l) => l.productId);
			if (unnamed.length) {
				const names = await fetchErpItemNames(erp, unnamed);
				for (const l of lines) if (!l.name) l.name = names.get(l.productId) ?? `товар #${l.productId}`;
			}
			lines.sort((a, b2) => a.name.localeCompare(b2.name, 'ru'));
			return { lines, storeName };
		};

		// Болванка: посчитать строки документа ядра, НИЧЕГО не записывая (1С: «не сохранил — пропала»).
		app.post('/api/inventory/erp-doc-preview', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number };
			const client = clientFrom(b);
			if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
			if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
			try {
				const { pt } = await loadPoint(client, b.inventoryId, Number(b.storeId));
				if (String(pt['status']) !== 'reconciled') return reply.code(200).send({ ok: false, error: 'документ ядра — только по сверённой точке' });
				const { lines, storeName } = await computeRecoLines(erp, pt);
				app.log.info({ storeId: b.storeId, lines: lines.length }, '[api/inventory/erp-doc-preview] ok');
				return { ok: true, lines, storeName, doc: pt['erpDoc'] ?? null };
			} catch (err) {
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-preview] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		// «Записать»: создать ЧЕРНОВИК Stock Reconciliation в ядре (остатки НЕ двигаются).
		app.post('/api/inventory/erp-doc-save', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number; recreate?: boolean };
			const client = clientFrom(b);
			if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
			if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
			try {
				const { item, data, points, pt } = await loadPoint(client, b.inventoryId, Number(b.storeId));
				if (String(pt['status']) !== 'reconciled') return reply.code(200).send({ ok: false, error: 'документ ядра — только по сверённой точке' });
				const prev = pt['erpDoc'] as { name?: string; status?: string } | undefined;
				if (prev?.name && prev.status === 'submitted') return reply.code(200).send({ ok: false, error: `документ ${prev.name} уже проведён`, doc: prev });
				if (prev?.name && prev.status === 'draft') {
					if (!b.recreate) return reply.code(200).send({ ok: false, error: `черновик ${prev.name} уже записан (recreate — пересоздать)`, doc: prev });
					await deleteInventoryRecoDraft(erp, prev.name); // «передумал»: пересоздаём от свежей болванки
				}
				const { lines, storeName } = await computeRecoLines(erp, pt);
				const recoLines: InventoryRecoLine[] = lines.map((l) => ({ productId: l.productId, qty: l.fact, valuation: l.valuation }));
				const { name } = await createInventoryRecoDraft(erp, {
					invRef: `inv${b.inventoryId}:store${b.storeId}`,
					storeTitle: storeName,
					lines: recoLines,
				});
				const doc = { name, status: 'draft', lines: lines.length, savedAt: new Date().toISOString() };
				pt['erpDoc'] = doc;
				data['points'] = points;
				await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId, NAME: item['NAME'], DETAIL_TEXT: JSON.stringify(data) });
				app.log.info({ storeId: b.storeId, name }, '[api/inventory/erp-doc-save] ok');
				return { ok: true, doc };
			} catch (err) {
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-save] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		// «Провести»: submit ядра (двигает остатки ERPNext).
		app.post('/api/inventory/erp-doc-submit', async (req, reply) => {
			const b = (req.body ?? {}) as AuthBody & { inventoryId?: string; storeId?: number };
			const client = clientFrom(b);
			if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
			if (!b.inventoryId || b.storeId == null) return reply.code(400).send({ ok: false, error: 'inventoryId/storeId required' });
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено (ERPNEXT_URL)' });
			try {
				const { item, data, points, pt } = await loadPoint(client, b.inventoryId, Number(b.storeId));
				const doc = pt['erpDoc'] as { name?: string; status?: string; lines?: number } | undefined;
				if (!doc?.name) return reply.code(200).send({ ok: false, error: 'сначала «Записать» (черновика ядра нет)' });
				// ИДЕМПОТЕНТНО: проведение в ядре может пережить таймаут фронта, а entity-запись — нет.
				// Повторное «Провести» дозавершает запись статуса, но не проводит документ повторно.
				const live = await erp.get('Stock Reconciliation', doc.name);
				if (!live) return reply.code(200).send({ ok: false, error: `${doc.name} не найден в ядре — пересоздай через «Записать»` });
				if (Number(live['docstatus'] ?? 0) !== 1) await submitInventoryReco(erp, doc.name);
				else app.log.info({ name: doc.name }, '[api/inventory/erp-doc-submit] reco уже проведён — дозавершаю');
				pt['erpDoc'] = { ...doc, status: 'submitted', submittedAt: new Date().toISOString() };
				data['points'] = points;
				await client.call('entity.item.update', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId, NAME: item['NAME'], DETAIL_TEXT: JSON.stringify(data) });
				app.log.info({ storeId: b.storeId, name: doc.name }, '[api/inventory/erp-doc-submit] ok');
				return { ok: true, doc: pt['erpDoc'] };
			} catch (err) {
				app.log.error({ storeId: b.storeId }, `[api/inventory/erp-doc-submit] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		app.post('/api/inventory/delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { inventoryId?: string };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.inventoryId) return reply.code(400).send({ ok: false, error: 'inventoryId required' });

		try {
			await client.call('entity.item.delete', { ENTITY: INVENTORY_ENTITY, ID: b.inventoryId });
			app.log.info({ id: b.inventoryId }, '[api/inventory/delete] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({ id: b.inventoryId }, `[api/inventory/delete] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
