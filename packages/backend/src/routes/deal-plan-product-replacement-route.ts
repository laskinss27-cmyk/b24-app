import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { setDealB24Service } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import { assertDealQuoteVariantSelected, calculateDealPlanTotal, replaceDealPlanSupplyProduct } from '../erp/operations.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SupplyTransferAllocation = (client: B24Client, dealId: number) => Promise<Map<string, Map<number, number>>>;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerDealPlanProductReplacementRoute(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	supplyTransferAllocation: SupplyTransferAllocation,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	app.post('/api/deal/replace-plan-product', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; oldProductId?: unknown; newProductId?: unknown; newItemName?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		const dealId = Number(b.dealId);
		const oldProductId = Number(b.oldProductId);
		const newProductId = Number(b.newProductId);
		if (![dealId, oldProductId, newProductId].every((value) => Number.isInteger(value) && value > 0)) {
			return reply.code(400).send({ ok: false, error: 'некорректные данные замены' });
		}
		try {
			await assertDealQuoteVariantSelected(erp, dealId);
			const transferAllocation = await supplyTransferAllocation(client, dealId);
			const plan = await replaceDealPlanSupplyProduct(erp, {
				dealId,
				oldProductId,
				newProductId,
				newItemName: String(b.newItemName ?? '').trim(),
				deliveryDate: new Date().toISOString().slice(0, 10),
				transferAllocation,
			});
			const total = await calculateDealPlanTotal(erp, dealId);
			await setDealB24Service(client, dealId, total);
			await syncDealTechnicalFields(client, erp, dealId);
			app.log.info({ dealId, oldProductId, newProductId }, '[api/deal/replace-plan-product] ok');
			return { ok: true, total, lines: plan.length };
		} catch (err) {
			app.log.error({ dealId, oldProductId, newProductId }, `[api/deal/replace-plan-product] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
