import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { ensureTransfersEntity, TRANSFERS_ENTITY } from '../b24/placement.js';
import { setDealB24Service } from '../deal-product-catalog.js';
import { ErpClient } from '../erp/client.js';
import {
	cancelDealQuoteVariantSelection,
	createDealQuoteVariant,
	deleteDealQuoteVariant,
	listDealPlan,
	listDealQuoteVariants,
	listDealRealizations,
	listDealStages,
	listSupplyRequestsForDeal,
	renameDealQuoteVariant,
	selectDealQuoteVariant,
} from '../erp/operations.js';
import { parseTransferItem } from '../transfers/model.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type DealClientFrom = (body: AuthBody) => B24Client | null;
type SyncDealTechnicalFields = (client: B24Client, erp: ErpClient, dealId: number) => Promise<void>;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

async function hasDealQuoteVariantActivity(client: B24Client, erp: ErpClient, dealId: number): Promise<boolean> {
	await ensureTransfersEntity(client);
	const [stages, realizations, supply, transferItems] = await Promise.all([
		listDealStages(erp, dealId),
		listDealRealizations(erp, dealId),
		listSupplyRequestsForDeal(erp, dealId),
		client.call<Array<Record<string, unknown>>>('entity.item.get', { ENTITY: TRANSFERS_ENTITY, SORT: { ID: 'DESC' } }),
	]);
	const transfers = (transferItems ?? []).map(parseTransferItem).filter((item) => item?.dealId === String(dealId));
	return stages.length > 0 || realizations.length > 0 || supply.length > 0 || transfers.length > 0;
}

export function registerDealQuoteVariantRoutes(
	app: FastifyInstance,
	clientFrom: DealClientFrom,
	syncDealTechnicalFields: SyncDealTechnicalFields,
): void {
	app.post('/api/deal/variants', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try { return { ok: true, variants: await listDealQuoteVariants(erp, dealId) }; }
		catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});

	app.post('/api/deal/variant-create', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; name?: unknown; sourceVariantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const current = await listDealQuoteVariants(erp, dealId);
			const selectCreated = !current.enabled && await hasDealQuoteVariantActivity(client, erp, dealId);
			const me = await client.call<{ ID?: unknown; NAME?: unknown; LAST_NAME?: unknown }>('user.current', {});
			const variants = await createDealQuoteVariant(erp, dealId, {
				name: String(b.name ?? ''),
				...(String(b.sourceVariantId ?? '').trim() ? { sourceVariantId: String(b.sourceVariantId).trim() } : {}),
				createdById: String(me?.ID ?? ''),
				createdByName: [String(me?.NAME ?? '').trim(), String(me?.LAST_NAME ?? '').trim()].filter(Boolean).join(' '),
				...(selectCreated ? { selectCreated: true } : {}),
			});
			return { ok: true, variants };
		} catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});

	app.post('/api/deal/variant-rename', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; variantId?: unknown; name?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try { return { ok: true, variants: await renameDealQuoteVariant(erp, Number(b.dealId), String(b.variantId ?? ''), String(b.name ?? '')) }; }
		catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});

	app.post('/api/deal/variant-delete', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try { return { ok: true, variants: await deleteDealQuoteVariant(erp, Number(b.dealId), String(b.variantId ?? '')) }; }
		catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});

	app.post('/api/deal/variant-select', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; variantId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const variantId = String(b.variantId ?? '').trim();
			const current = await listDealQuoteVariants(erp, dealId);
			if (!current.variants.some((variant) => variant.id === variantId)) throw new Error('вариант не найден');
			if (current.selectedId && current.selectedId !== variantId) {
				if (await hasDealQuoteVariantActivity(client, erp, dealId)) {
					throw new Error('основной вариант зафиксирован: по нему уже есть этапы, заявки снабжению, реализации или перемещения');
				}
			}
			const variants = await selectDealQuoteVariant(erp, dealId, variantId, new Date().toISOString().slice(0, 10));
			const items = await listDealPlan(erp, dealId);
			const total = Math.round(items.reduce((sum, item) => sum + item.rate * item.qty, 0) * 100) / 100;
			await setDealB24Service(client, dealId, total);
			await syncDealTechnicalFields(client, erp, dealId);
			return { ok: true, variants, total };
		} catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});

	app.post('/api/deal/variant-selection-cancel', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(b.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(200).send({ ok: false, error: 'ядро склада не подключено' });
		try {
			const current = await listDealQuoteVariants(erp, dealId);
			if (!current.selectedId) return { ok: true, variants: current };
			if (await hasDealQuoteVariantActivity(client, erp, dealId)) {
				throw new Error('основной вариант зафиксирован: по нему уже есть этапы, заявки снабжению, реализации или перемещения');
			}
			return { ok: true, variants: await cancelDealQuoteVariantSelection(erp, dealId) };
		} catch (err) { return reply.code(200).send({ ok: false, error: errInfo(err) }); }
	});
}
