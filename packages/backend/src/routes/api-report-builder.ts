import type { FastifyInstance, FastifyReply } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { buildSalesReport } from '../b24/sales-report.js';
import { ErpClient } from '../erp/client.js';
import { listActiveStoreTitles } from '../erp/operations.js';
import { buildTurnoverReport } from '../erp/turnover-report.js';
import { normalizeDomain } from '../security.js';
import { reportBuilderUser } from '../report-builder/access.js';
import {
	REPORT_DATASETS,
	buildReportResult,
	validateReportDefinition,
	type ReportDefinition,
	type ReportRow,
} from '../report-builder/model.js';
import { ReportBuilderStore, ReportStoreConflictError } from '../report-builder/store.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : error instanceof Error ? error.message : String(error);
}

function clientFrom(app: FastifyInstance, body: AuthBody): B24Client | null {
	if (!body.domain || !body.accessToken) return null;
	if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
	return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
}

function dateOnly(value: string): string {
	return value ? value.slice(0, 10) : '';
}

function salesRows(rows: Awaited<ReturnType<typeof buildSalesReport>>['rows']): ReportRow[] {
	return rows.map((row) => ({
		dealId: row.dealId,
		category: row.category,
		source: row.source,
		dateCreate: dateOnly(row.dateCreate),
		dateClosed: dateOnly(row.dateClosed),
		closedMonth: dateOnly(row.dateClosed).slice(0, 7),
		title: row.title,
		manager: row.manager,
		goodsSum: row.goodsSum,
		worksSum: row.worksSum,
		totalSum: row.goodsSum + row.worksSum,
		goodsProfit: row.goodsProfit,
		worksProfit: row.worksProfit,
		totalProfit: row.goodsProfit + row.worksProfit,
		goodsNoPurchase: row.goodsNoPurchase,
		__count: 1,
	}));
}

function turnoverRows(rows: Awaited<ReturnType<typeof buildTurnoverReport>>['rows']): ReportRow[] {
	return rows.map((row) => ({
		productId: row.productId,
		name: row.name,
		article: row.article,
		brand: row.brand,
		section: row.section,
		currentQty: row.currentQty,
		reservedQty: row.reservedQty,
		orderedQty: row.orderedQty,
		availableQty: row.availableQty,
		openingQty: row.openingQty,
		closingQty: row.closingQty,
		averageQty: row.averageQty,
		receivedQty: row.receivedQty,
		soldQty: row.soldQty,
		returnedQty: row.returnedQty,
		writtenOffQty: row.writtenOffQty,
		turns: row.turns,
		dailySales: row.dailySales,
		daysOfStock: row.daysOfStock,
		averagePurchasePrice: row.averagePurchasePrice,
		stockValue: row.stockValue,
		lastReceiptDate: row.lastReceiptDate,
		lastSaleDate: row.lastSaleDate,
		status: row.status,
		__count: 1,
	}));
}

async function categoryOptions(client: B24Client): Promise<Array<{ id: number; name: string }>> {
	try {
		const result = await client.call<{ categories?: Array<Record<string, unknown>> }>('crm.category.list', { entityTypeId: 2 });
		const categories = (result.categories ?? [])
			.map((category) => ({ id: Number(category['id']), name: String(category['name'] ?? '').trim() }))
			.filter((category) => Number.isInteger(category.id) && category.id >= 0 && category.name);
		if (!categories.some((category) => category.id === 0)) categories.unshift({ id: 0, name: 'Объекты' });
		return categories.sort((left, right) => left.id - right.id);
	} catch {
		return [{ id: 0, name: 'Объекты' }];
	}
}

export function registerApiReportBuilderRoute(app: FastifyInstance): void {
	const store = new ReportBuilderStore();

	const authorize = async (body: AuthBody, reply: FastifyReply) => {
		const client = clientFrom(app, body);
		if (!client) {
			reply.code(403).send({ ok: false, error: 'нет авторизации' });
			return null;
		}
		const user = await reportBuilderUser(client);
		if (!user) {
			reply.code(403).send({ ok: false, error: 'конструктор доступен только администраторам и Владимиру Дранишникову' });
			return null;
		}
		return { client, user };
	};

	app.post('/api/report-builder/bootstrap', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody;
		const auth = await authorize(body, reply);
		if (!auth) return;
		try {
			const erp = ErpClient.fromEnv();
			const [reports, categories, stores] = await Promise.all([
				store.list(auth.user.id),
				categoryOptions(auth.client),
				erp ? listActiveStoreTitles(erp).catch(() => []) : Promise.resolve([]),
			]);
			return { ok: true, user: auth.user, datasets: REPORT_DATASETS, reports, options: { categories, stores } };
		} catch (error) {
			app.log.error({ userId: auth.user.id }, `[report-builder/bootstrap] ${errInfo(error)}`);
			return reply.code(500).send({ ok: false, error: 'не удалось открыть личные отчёты' });
		}
	});

	app.post('/api/report-builder/run', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { definition?: unknown };
		const auth = await authorize(body, reply);
		if (!auth) return;
		const startedAt = Date.now();
		try {
			const definition = validateReportDefinition(body.definition);
			let sourceRows: ReportRow[];
			if (definition.datasetId === 'sales_deals') {
				const params: { from: string; to: string; categoryIds?: number[] } = {
					from: definition.filters.from,
					to: definition.filters.to,
				};
				if (definition.filters.categoryIds?.length) params.categoryIds = definition.filters.categoryIds;
				sourceRows = salesRows((await buildSalesReport(auth.client, params)).rows);
			} else {
				const erp = ErpClient.fromEnv();
				if (!erp) return reply.code(503).send({ ok: false, error: 'ядро складского учёта недоступно' });
				const params: { from: string; to: string; store?: string } = {
					from: definition.filters.from,
					to: definition.filters.to,
				};
				if (definition.filters.store) params.store = definition.filters.store;
				sourceRows = turnoverRows((await buildTurnoverReport(erp, params)).rows);
			}
			const result = buildReportResult(definition, sourceRows);
			app.log.info({ userId: auth.user.id, datasetId: definition.datasetId, rows: result.totalRows, ms: Date.now() - startedAt }, '[report-builder/run] ok');
			return { ok: true, ...result, generatedAt: new Date().toISOString() };
		} catch (error) {
			app.log.warn({ userId: auth.user.id, ms: Date.now() - startedAt }, `[report-builder/run] ${errInfo(error)}`);
			return reply.code(400).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/report-builder/save', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & {
			id?: unknown;
			name?: unknown;
			definition?: unknown;
			expectedUpdatedAt?: unknown;
		};
		const auth = await authorize(body, reply);
		if (!auth) return;
		try {
			const definition = validateReportDefinition(body.definition);
			const input: { id?: string; name: string; definition: ReportDefinition; expectedUpdatedAt?: string } = {
				name: String(body.name ?? ''),
				definition,
			};
			if (typeof body.id === 'string' && body.id) input.id = body.id;
			if (typeof body.expectedUpdatedAt === 'string') input.expectedUpdatedAt = body.expectedUpdatedAt;
			const report = await store.save(auth.user.id, input);
			return { ok: true, report };
		} catch (error) {
			const code = error instanceof ReportStoreConflictError ? 409 : 400;
			return reply.code(code).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/report-builder/delete', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { id?: unknown };
		const auth = await authorize(body, reply);
		if (!auth) return;
		const deleted = typeof body.id === 'string' && await store.delete(auth.user.id, body.id);
		if (!deleted) return reply.code(404).send({ ok: false, error: 'личный отчёт не найден' });
		return { ok: true };
	});
}
