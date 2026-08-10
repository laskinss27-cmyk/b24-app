import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { ErpClient } from '../erp/client.js';
import {
	searchErpItems, listActiveStoreTitles, fetchErpStocksFor,
	ensureSupplier, ensureCoreItem, createReceiptDraft, createWriteOffDraft, submitDoc,
	updateCoreCatalogPrices,
} from '../erp/operations.js';
import { buildTurnoverReport } from '../erp/turnover-report.js';
import { buildTurnoverXlsx, type TurnoverExportFilters } from '../erp/turnover-report-xlsx.js';
import {
	buildAssortmentMatrixReport,
	saveAssortmentMatrixItem,
	type MatrixSalesScope,
} from '../erp/assortment-matrix.js';
import { appPermission } from '../access-policy.js';
import { canManageStock, canUseAssortmentMatrix, stockAccess } from './api-stock-access.js';
import { validateFreeStock } from './api-stock-availability.js';
import { matrixCategories } from './api-stock-matrix-categories.js';
import { registerStockMovementRoutes } from './api-stock-movement-routes.js';
import { moscowDate, stockClientFrom, stockErrorInfo as errInfo } from './api-stock-route-helpers.js';
import { fetchSupplierCompanies } from './api-stock-suppliers.js';
import type { StockAuthBody as AuthBody, StockIssueLine as IssueLine, StockReceiptLine as ReceiptLine } from './api-stock-types.js';

export { canManageStock } from './api-stock-access.js';
export { validateFreeStock } from './api-stock-availability.js';

/**
 * API окна «Складской учёт».
 *  - /api/stock/movements   — read-only журнал (списания/оприходования/реализации);
 *  - /api/stock/form-data   — справочники для форм создания (склады, поставщики, право);
 *  - /api/stock/search-items — поиск товаров каталога ядра (пикер позиций);
 *  - /api/stock/create      — создать ЧЕРНОВИК прихода/списания (Provести — отдельно);
 *  - /api/stock/submit      — провести черновик (двигает остатки ядра).
 * Перемещения — отдельный роут /api/transfers/*.
 * Авторизация — Б24-oauth (домен из allowlist). Создание/проведение — снабжение и руководители.
 */
export function registerApiStockRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => stockClientFrom(app, body);
	registerStockMovementRoutes(app);

	// Отчёт оборачиваемости по всем товарным позициям. Только чтение данных ядра.
	app.post('/api/stock/turnover-report', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { from?: unknown; to?: unknown; store?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const from = String(b.from ?? '');
		const to = String(b.to ?? '');
		const today = moscowDate();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			return reply.code(400).send({ ok: false, error: 'нужны даты от и до' });
		}
		if (from > to) return reply.code(400).send({ ok: false, error: 'дата «от» должна быть раньше даты «до»' });
		if (to > today) return reply.code(400).send({ ok: false, error: 'отчёт нельзя построить за будущий период' });
		const store = String(b.store ?? '').trim();
		try {
			const data = await buildTurnoverReport(erp, { from, to, ...(store ? { store } : {}) });
			app.log.info({ rows: data.rows.length, from, to, store }, '[api/stock/turnover-report] ok');
			return { ok: true, ...data };
		} catch (e) {
			app.log.error({}, `[api/stock/turnover-report] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Excel-снимок отчёта с текущими фильтрами и настройкой ценовых колонок.
	app.post('/api/stock/turnover-report.xlsx', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & {
			from?: unknown; to?: unknown; store?: unknown; search?: unknown; status?: unknown; section?: unknown;
			showAverageCost?: unknown; showStockValue?: unknown;
		};
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const from = String(b.from ?? '');
		const to = String(b.to ?? '');
		const today = moscowDate();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			return reply.code(400).send({ ok: false, error: 'нужны даты от и до' });
		}
		if (from > to) return reply.code(400).send({ ok: false, error: 'дата «от» должна быть раньше даты «до»' });
		if (to > today) return reply.code(400).send({ ok: false, error: 'отчёт нельзя построить за будущий период' });
		const store = String(b.store ?? '').trim();
		const statusValue = String(b.status ?? '').trim();
		const allowedStatuses = new Set(['ending', 'ordered', 'normal', 'excess', 'no_movement', 'no_stock']);
		const filters: TurnoverExportFilters = {
			showAverageCost: b.showAverageCost !== false,
			showStockValue: b.showStockValue !== false,
			...(String(b.search ?? '').trim() ? { search: String(b.search).trim() } : {}),
			...(String(b.section ?? '').trim() ? { section: String(b.section).trim() } : {}),
			...(allowedStatuses.has(statusValue) ? { status: statusValue as NonNullable<TurnoverExportFilters['status']> } : {}),
		};
		try {
			const report = await buildTurnoverReport(erp, { from, to, ...(store ? { store } : {}) });
			const file = await buildTurnoverXlsx({
				from, to, store, rows: report.rows, filters, generatedAt: new Date(),
			});
			app.log.info({ rows: report.rows.length, from, to, store }, '[api/stock/turnover-report.xlsx] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="turnover-${from}-${to}.xlsx"`)
				.header('Cache-Control', 'no-store')
				.send(file);
		} catch (e) {
			app.log.error({}, `[api/stock/turnover-report.xlsx] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Канареечная матрица ассортимента и заказа. На этапе проверки доступна только Сергею #1858.
	app.post('/api/stock/assortment-matrix', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & {
			from?: unknown; to?: unknown; selectedStores?: unknown; salesScope?: unknown;
		};
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await canUseAssortmentMatrix(client))) return reply.code(403).send({ ok: false, error: 'матрица пока доступна только канарейке' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const from = String(b.from ?? '');
		const to = String(b.to ?? '');
		const today = moscowDate();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
			return reply.code(400).send({ ok: false, error: 'нужны даты от и до' });
		}
		if (from > to) return reply.code(400).send({ ok: false, error: 'дата «от» должна быть раньше даты «до»' });
		if (to > today) return reply.code(400).send({ ok: false, error: 'отчёт нельзя построить за будущий период' });
		const selectedStores = Array.isArray(b.selectedStores)
			? b.selectedStores.map((value) => String(value).trim()).filter(Boolean).slice(0, 50)
			: [];
		const salesScope: MatrixSalesScope = b.salesScope === 'all' ? 'all' : 'selected';
		try {
			const [report, categories] = await Promise.all([
				buildAssortmentMatrixReport(erp, { from, to, selectedStores, salesScope }),
				matrixCategories(client).catch((error) => {
					app.log.warn({ error: errInfo(error) }, '[api/stock/assortment-matrix] categories unavailable');
					return [];
				}),
			]);
			app.log.info({ rows: report.rows.length, from, to, salesScope, stores: report.selectedStores.length }, '[api/stock/assortment-matrix] ok');
			return { ok: true, ...report, categories };
		} catch (error) {
			app.log.error({}, `[api/stock/assortment-matrix] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/stock/assortment-matrix/save', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & {
			productId?: unknown; enabled?: unknown; category?: unknown; segment?: unknown;
			toOrderQty?: unknown; comment?: unknown;
		};
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		if (!(await canUseAssortmentMatrix(client))) return reply.code(403).send({ ok: false, error: 'матрица пока доступна только канарейке' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const productId = Number(b.productId);
		if (!Number.isInteger(productId) || productId <= 0) return reply.code(400).send({ ok: false, error: 'некорректный товар' });
		try {
			await saveAssortmentMatrixItem(erp, {
				productId,
				enabled: b.enabled !== false,
				category: String(b.category ?? ''),
				segment: String(b.segment ?? ''),
				toOrderQty: Number(b.toOrderQty ?? 0),
				comment: String(b.comment ?? ''),
			});
			app.log.info({ productId, enabled: b.enabled !== false }, '[api/stock/assortment-matrix/save] ok');
			return { ok: true };
		} catch (error) {
			app.log.error({ productId }, `[api/stock/assortment-matrix/save] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	// Справочники для форм: склады, поставщики, право создавать по учётной записи.
	app.post('/api/stock/form-data', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const [stores, suppliers, access] = await Promise.all([
				listActiveStoreTitles(erp), fetchSupplierCompanies(client, app.log), stockAccess(client),
			]);
			const canCreate = appPermission(req, 'stock.create_receipt', access.canManage)
				|| appPermission(req, 'stock.create_issue', access.canManage);
			const isSupply = appPermission(req, 'supply.view', access.isSupply);
			return { ok: true, stores, suppliers, canCreate, isSupply };
		} catch (e) {
			app.log.error({}, `[api/stock/form-data] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Поиск товаров каталога ядра (по id / имени / артикулу) — пикер позиций в формах.
	app.post('/api/stock/search-items', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { q?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const items = await searchErpItems(erp, String(b.q ?? ''));
			// Обогащаем остатками по складам (один батч-запрос Bin) — чтобы в пикере было видно наличие
			// и «живую» карточку среди дублей.
			const stockMap = await fetchErpStocksFor(erp, items.map((i) => i.productId));
			const enriched = items.map((i) => {
				const stocks = stockMap.get(i.productId) ?? {};
				const total = Object.values(stocks).reduce((a, b) => a + b, 0);
				return { ...i, stocks, total };
			});
			return { ok: true, items: enriched };
		} catch (e) {
			app.log.error({}, `[api/stock/search-items] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Создать НОВЫЙ товар (которого нет в каталоге): продукт в каталоге Б24 (iblock 24, простой, штуки)
	// → productId → зеркало Item в ядре. Возвращает {productId, name} для добавления в приход. Доступ — снабжение.
	app.post('/api/stock/create-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (name.length < 2) return reply.code(400).send({ ok: false, error: 'имя товара слишком короткое' });
		try {
			if (!appPermission(req, 'stock.create_product', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'создавать товар может только снабжение' });
			}
			// iblock 24 = базовый каталог CRM (productIblockId=null); type 1 = простой товар; measure 9 = штуки (дефолт портала).
			const r = await client.call<{ element?: { id?: number | string } }>('catalog.product.add', { fields: { iblockId: 24, name, type: 1, measure: 9, active: 'Y' } });
			const productId = Number(r?.element?.id ?? 0) || 0;
			if (!productId) throw new Error('catalog.product.add не вернул id');
			await ensureCoreItem(erp, { productId, name });
			app.log.info({ productId, name }, '[api/stock/create-product] ok');
			return { ok: true, productId, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create-product] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Создать ЧЕРНОВИК: kind 'receipt' (Приход) | 'issue' (Списание). Перемещения — /api/transfers.
	app.post('/api/stock/create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & Record<string, unknown>;
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		try {
			const kind = b['kind'] === 'receipt' ? 'receipt' : b['kind'] === 'issue' ? 'issue' : null;
			if (!kind) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
			const permissionId = kind === 'receipt' ? 'stock.create_receipt' : 'stock.create_issue';
			if (!appPermission(req, permissionId, await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'создавать складские документы может только снабжение' });
			}

			if (kind === 'receipt') {
				const toStore = String(b['toStore'] ?? '').trim();
				if (!toStore) return reply.code(400).send({ ok: false, error: 'не выбран склад прихода' });
				const lines: ReceiptLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
					.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']), purchase: Number(l['purchase'] ?? 0), retail: Number(l['retail'] ?? 0) }))
					.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
				if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
				const supplierIn = String(b['supplier'] ?? '').trim();
				const supplier = supplierIn ? await ensureSupplier(erp, supplierIn) : undefined;
				const note = String(b['note'] ?? '').trim();
				const { name } = await createReceiptDraft(erp, {
					...(supplier ? { supplier } : {}),
					...(note ? { note } : {}),
					lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, toStore, rate: l.purchase })),
				});
				for (const line of lines) {
					const prices: { productId: number; retail?: number; purchase?: number } = { productId: line.productId };
					if (line.retail > 0) prices.retail = line.retail;
					if (line.purchase > 0) prices.purchase = line.purchase;
					if (prices.retail !== undefined || prices.purchase !== undefined) await updateCoreCatalogPrices(erp, prices);
				}
				app.log.info({ name, lines: lines.length }, '[api/stock/create] receipt draft');
				return { ok: true, kind, name };
			}

			// issue
			const fromStore = String(b['fromStore'] ?? '').trim();
			if (!fromStore) return reply.code(400).send({ ok: false, error: 'не выбран склад списания' });
			const reason = String(b['reason'] ?? '').trim();
			const note = String(b['note'] ?? '').trim();
			const lines: IssueLine[] = (Array.isArray(b['lines']) ? b['lines'] as Array<Record<string, unknown>> : [])
				.map((l) => ({ productId: Number(l['productId']), qty: Number(l['qty']) }))
				.filter((l) => Number.isInteger(l.productId) && l.productId > 0 && l.qty > 0);
			if (!lines.length) return reply.code(400).send({ ok: false, error: 'нет позиций с количеством > 0' });
			await validateFreeStock(client, erp, lines.map((line) => ({ ...line, fromStore })));
			const { name } = await createWriteOffDraft(erp, {
				...(reason ? { reason } : {}),
				...(note ? { note } : {}),
				lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, fromStore })),
			});
			app.log.info({ name, lines: lines.length }, '[api/stock/create] issue draft');
			return { ok: true, kind, name };
		} catch (e) {
			app.log.error({}, `[api/stock/create] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});

	// Провести черновик: kind 'receipt' (Purchase Receipt) | 'issue' (Stock Entry).
	app.post('/api/stock/submit', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { kind?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно' });
		const name = String(b.name ?? '').trim();
		if (!name) return reply.code(400).send({ ok: false, error: 'нет имени документа' });
		const doctype = b.kind === 'receipt' ? 'Purchase Receipt' : b.kind === 'issue' ? 'Stock Entry' : null;
		if (!doctype) return reply.code(400).send({ ok: false, error: 'kind должен быть receipt|issue' });
		try {
			if (!appPermission(req, 'stock.post_documents', await canManageStock(client))) {
				return reply.code(403).send({ ok: false, error: 'проводить складские документы может только снабжение' });
			}
			if (b.kind === 'issue') {
				const doc = await erp.get<Record<string, unknown>>('Stock Entry', name);
				const stores = await listActiveStoreTitles(erp);
				const rawLines = Array.isArray(doc?.['items']) ? doc?.['items'] as Array<Record<string, unknown>> : [];
				const lines = rawLines
					.map((line) => {
						const warehouse = String(line['s_warehouse'] ?? '');
						const fromStore = stores.find((store) => warehouse === store || warehouse.startsWith(`${store} - `)) ?? '';
						return { productId: Number(line['item_code']), qty: Number(line['qty']), fromStore };
					})
					.filter((line) => Number.isInteger(line.productId) && line.productId > 0 && line.qty > 0 && line.fromStore);
				if (lines.length !== rawLines.length) throw new Error('не удалось проверить склад строк списания');
				await validateFreeStock(client, erp, lines);
			}
			await submitDoc(erp, doctype, name);
			app.log.info({ name, doctype }, '[api/stock/submit] ok');
			return { ok: true, name };
		} catch (e) {
			app.log.error({}, `[api/stock/submit] failed — ${errInfo(e)}`);
			return reply.code(200).send({ ok: false, error: errInfo(e) });
		}
	});
}
