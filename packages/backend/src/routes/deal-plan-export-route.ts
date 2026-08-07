import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { dealExportRows, type ExportPlanLine } from '../deal-export-rows.js';
import { buildDealExportXlsx } from '../deal-export-xlsx.js';
import { ErpClient } from '../erp/client.js';
import { listDealPlan, listDealQuoteVariants, listDealRealizations, listDealStages, type DealStage, type ErpRealization } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealPlanExportRoute(app: FastifyInstance, clientFrom: DealClientFrom): void {
	// Excel-снимок состава сделки: товары и услуги, этапы, цены, скидки и фактически проведённая реализация.
	// Для ещё не выбранного варианта КП выгружается сам вариант без складской истории рабочей сделки.
	app.post('/api/deal/export-xlsx', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const deal = await client.call<Record<string, unknown>>('crm.deal.get', { id: dealId });
			const erp = ErpClient.fromEnv();
			const variantId = String(b.variantId ?? '').trim();
			if (variantId && !erp) throw new Error('ядро недоступно — вариант КП нельзя выгрузить');

			let plan: ExportPlanLine[] = [];
			let stages: DealStage[] = [];
			let realizations: ErpRealization[] = [];
			if (erp) {
				if (variantId) {
					const variants = await listDealQuoteVariants(erp, dealId);
					const variant = variants.variants.find((item) => item.id === variantId);
					if (!variant) throw new Error('вариант КП не найден');
					plan = variant.items.map((item) => ({ ...item, isService: Boolean(item.isService) }));
				} else {
					[plan, stages, realizations] = await Promise.all([
						listDealPlan(erp, dealId),
						listDealStages(erp, dealId),
						listDealRealizations(erp, dealId),
					]);
				}
			}
			const rows = dealExportRows(plan, stages, realizations, Boolean(variantId));
			const file = await buildDealExportXlsx({
				dealId,
				dealTitle: String(deal?.['TITLE'] ?? ''),
				rows,
			});
			app.log.info({ dealId, variantId: variantId || undefined, rows: rows.length }, '[api/deal/export-xlsx] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
				.header('Content-Disposition', `attachment; filename="deal-${dealId}.xlsx"`)
				.header('Cache-Control', 'no-store')
				.send(file);
		} catch (err) {
			app.log.error({ dealId }, `[api/deal/export-xlsx] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
