import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { ensureInventoryEntity, INVENTORY_ENTITY } from '../b24/placement.js';
import { normalizeDomain } from '../security.js';
import { ErpClient } from '../erp/client.js';
import {
	coreStoreId,
	createInventoryRecoDraft,
	deleteInventoryRecoDraft,
	fetchErpItemNames,
	fetchErpStoreStock,
	fetchErpStoreStockFull,
	listActiveStoreTitles,
	searchErpItems,
	submitInventoryReco,
	type InventoryRecoLine,
} from '../erp/operations.js';

/**
 * API инвентаризации для фронта. Фронтовый BX24 ВИСНЕТ на entity.* — поэтому
 * все операции с хранилищем (entity) делаем здесь, серверным B24Client (чистый
 * JSON, app-контекст). Фронт шлёт сюда свой BX24-токен (BX24.getAuth) + домен.
 *
 * Эндпоинты read/write только в нашей сущности ctv_inv; токен — самого юзера,
 * поэтому права Битрикса соблюдаются. Домен сверяем с порталом (allowlist).
 */
interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

/**
 * ctv_inv хранит все точки одной инвентаризации в одной JSON-записи. Поэтому
 * параллельные read-modify-write двух складов обязаны идти последовательно,
 * иначе более поздний entity.item.update может вернуть старую версию соседней точки.
 * Production работает одним backend-контейнером, так что очередь на процесс надёжно
 * закрывает конкурентные автосохранения внутри текущей архитектуры хранения.
 */
const inventoryUpdateLocks = new Map<string, Promise<void>>();

export async function withInventoryUpdateLock<T>(inventoryId: string, work: () => Promise<T>): Promise<T> {
	const previous = inventoryUpdateLocks.get(inventoryId) ?? Promise.resolve();
	let release = (): void => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const tail = previous.catch(() => undefined).then(() => gate);
	inventoryUpdateLocks.set(inventoryId, tail);
	await previous.catch(() => undefined);
	try {
		return await work();
	} finally {
		release();
		if (inventoryUpdateLocks.get(inventoryId) === tail) inventoryUpdateLocks.delete(inventoryId);
	}
}

export function registerApiInventoryRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	// Список инвентаризаций (+ идемпотентно создаёт хранилище, если его ещё нет).
	app.post('/api/inventory/list', async (req, reply) => {
		const client = clientFrom((req.body ?? {}) as AuthBody);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });

		const ent = await ensureInventoryEntity(client);
		try {
			const items = await client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: INVENTORY_ENTITY });
			const inventories = (items ?? []).map((it) => {
				let parsed: Record<string, unknown> = {};
				try {
					parsed = it['DETAIL_TEXT'] ? (JSON.parse(String(it['DETAIL_TEXT'])) as Record<string, unknown>) : {};
				} catch {
					/* битый JSON — пропускаем */
				}
				return {
					id: String(it['ID'] ?? ''),
					title: String(it['NAME'] ?? ''),
					status: String(parsed['status'] ?? 'active'),
					deadline: String(parsed['deadline'] ?? ''),
					points: Array.isArray(parsed['points']) ? parsed['points'] : [],
					createdById: String(parsed['createdById'] ?? it['CREATED_BY'] ?? ''),
					createdAt: String(parsed['createdAt'] ?? it['DATE_CREATE'] ?? ''),
					sectionIds: Array.isArray(parsed['sectionIds']) ? parsed['sectionIds'] : [],
				};
			});
			inventories.sort((a, b) => Number(b.id) - Number(a.id));
			app.log.info({ entity: ent.status, count: inventories.length }, '[api/inventory/list] ok');
			return { ok: true, entity: ent.status, inventories };
		} catch (err) {
			app.log.error({ entity: ent.status }, `[api/inventory/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err), entity: ent.status });
		}
	});

	// Остатки склада для мобильного подсчёта (на телефоне нет BX24 SDK — собираем серверно).
	// Только ЧТЕНИЕ, токен юзера в теле (фронт getAuth или мобильный контекст) — права Б24 соблюдаются.
	app.post('/api/inventory/stock', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { storeId?: number; storeName?: unknown; sectionIds?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (b.storeId == null) return reply.code(400).send({ ok: false, error: 'storeId required' });
		// Учёт ИЗ ЯДРА (имя/модель/артикул/бренд/фото/остаток) — целиком, без кусков от Б24.
		// При недоступности ядра возвращаем ошибку: подмены складскими данными Б24 больше нет.
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const storeTitles = await listActiveStoreTitles(erp);
			const requestedTitle = String(b.storeName ?? '').trim().toLocaleLowerCase('ru-RU');
			const storeTitle = storeTitles.find((title) => coreStoreId(title) === Number(b.storeId))
				?? storeTitles.find((title) => title.toLocaleLowerCase('ru-RU') === requestedTitle);
			if (!storeTitle) return reply.code(400).send({ ok: false, error: 'склад ядра не найден' });
			const core = await fetchErpStoreStockFull(erp, storeTitle);
			const lines = core.map((l) => ({
					productId: l.productId,
					name: l.name,
					book: l.book,
					article: l.article || undefined,
					model: (l.article || l.model) || undefined,
					manufacturer: l.brand || undefined,
					sectionName: l.section || undefined,
					photoPath: l.image ? `/api/inventory/erp-image?p=${encodeURIComponent(l.image)}` : undefined,
				}));
			app.log.info({ storeId: b.storeId, count: lines.length, source: 'core' }, '[api/inventory/stock] ok');
			return { ok: true, lines };
		} catch (err) {
			app.log.error({ storeId: b.storeId }, `[api/inventory/stock] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

	// Прокси фото товара из ЯДРА: ERPNext отдаёт /files/... (публично, но URL ядра наружу не торчит).
	// GET для <img src>. Путь жёстко валидируем (только /files/<имя>) — не дать произвольный fetch.
	app.get('/api/inventory/erp-image', async (req, reply) => {
		const p = String((req.query as Record<string, unknown> | undefined)?.['p'] ?? '');
		if (!/^\/files\/[\w.\-]+$/.test(p)) return reply.code(400).send('bad path');
		const base = process.env['ERPNEXT_URL'];
		if (!base) return reply.code(404).send('core off');
		try {
			const r = await fetch(`${base.replace(/\/$/, '')}${p}`, { signal: AbortSignal.timeout(8000) });
			if (!r.ok) return reply.code(r.status).send('not found');
			const buf = Buffer.from(await r.arrayBuffer());
			reply.header('Content-Type', r.headers.get('content-type') ?? 'image/jpeg');
			reply.header('Cache-Control', 'public, max-age=86400');
			return reply.send(buf);
		} catch {
			return reply.code(502).send('image fetch failed');
		}
	});

	// Создать инвентаризацию.
	app.post('/api/inventory/search-products', async (req, reply) => {
			const sb = (req.body ?? {}) as AuthBody & { q?: string };
			const sClient = clientFrom(sb);
			if (!sClient) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
			const sq = String(sb.q ?? '').trim();
			if (sq.length < 2) return { ok: true, products: [] as Array<{ id: number; name: string }> };
			const erp = ErpClient.fromEnv();
			if (!erp) return reply.code(503).send({ ok: false, error: 'ядро склада не подключено' });
			try {
				const products = (await searchErpItems(erp, sq, 30))
					.map((item) => ({ id: item.productId, name: item.name }));
				app.log.info({ count: products.length }, '[api/inventory/search-products] ok');
				return { ok: true, products };
			} catch (err) {
				app.log.error({}, `[api/inventory/search-products] failed — ${errInfo(err)}`);
				return reply.code(200).send({ ok: false, error: errInfo(err) });
			}
		});

		app.post('/api/inventory/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { title?: string; points?: unknown; createdById?: string; deadline?: string; notifyUserIds?: unknown; sectionIds?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!b.title || !Array.isArray(b.points) || !b.points.length) {
			return reply.code(400).send({ ok: false, error: 'title/points required' });
		}

		await ensureInventoryEntity(client);
		try {
			const sectionIds = Array.isArray(b.sectionIds) ? b.sectionIds.map(Number).filter((n) => Number.isInteger(n) && n >= 0) : [];
			await client.call('entity.item.add', {
				ENTITY: INVENTORY_ENTITY,
				NAME: b.title,
				DETAIL_TEXT: JSON.stringify({ status: 'active', deadline: b.deadline ?? '', points: b.points, createdById: b.createdById ?? '', createdAt: new Date().toISOString(), sectionIds }),
			});

			// Оповещение задачей Б24 (одна на инвентаризацию). Постановщик/исполнитель — инициатор.
			// Соисполнители — кого инициатор выбрал в UI (notifyUserIds). Гейт config.inventoryNotify:
			//   off — никого (мьют на обкатке); on — шлём выбранным. Постановщика выкидываем (дедуп).
			// Не критично: ошибка задачи не валит создание инвенты.
			if (b.createdById) {
				const responsible = String(b.createdById);
				let accomplices: number[] = [];
				if (app.config.inventoryNotify === 'on' && Array.isArray(b.notifyUserIds)) {
					accomplices = [...new Set(b.notifyUserIds.map((s) => String(s).trim()))]
						.filter((s) => s && s !== responsible)
						.map((s) => Number(s))
						.filter((n) => Number.isInteger(n) && n > 0);
				}
				try {
					await client.call('tasks.task.add', {
						fields: {
							TITLE: `Инвентаризация: ${b.title}`,
							DESCRIPTION: `Создана инвентаризация «${b.title}»${b.deadline ? `, срок до ${b.deadline}` : ''}. Откройте раздел «Инвентаризация» в приложении и возьмите свою точку.${app.config.appSectionUrl ? `\n${app.config.appSectionUrl}` : ''}`,
							RESPONSIBLE_ID: Number(b.createdById),
							...(accomplices.length ? { ACCOMPLICES: accomplices } : {}),
							...(b.deadline ? { DEADLINE: b.deadline } : {}),
						},
					});
					app.log.info({ notify: app.config.inventoryNotify, accomplices: accomplices.length }, '[api/inventory/create] notify task created');
				} catch (e) {
					app.log.warn({}, `[api/inventory/create] notify task failed — ${errInfo(e)}`);
				}
			}

			app.log.info({}, '[api/inventory/create] ok');
			return { ok: true };
		} catch (err) {
			app.log.error({}, `[api/inventory/create] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});

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
