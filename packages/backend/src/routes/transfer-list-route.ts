import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { resolveDealOwners } from '../b24/deal-info.js';
import { ensureTransfersEntity } from '../b24/placement.js';
import { loadTransfers } from './transfer-storage.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferListRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
): void {
	app.post('/api/transfers/list', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { dealId?: unknown; from?: unknown; to?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		await ensureTransfersEntity(client);
		const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
		const from = isDate(b.from) ? b.from : '';
		const to = isDate(b.to) ? b.to : '';
		try {
			let transfers = await loadTransfers(app, client);
			const dealId = String(b.dealId ?? '').trim();
			if (dealId) transfers = transfers.filter((t) => t.dealId === dealId);
			if (from) transfers = transfers.filter((t) => (t.createdAt || '').slice(0, 10) >= from);
			if (to) transfers = transfers.filter((t) => (t.createdAt || '').slice(0, 10) <= to);
			const me = await currentUser(client);
			const owners = await resolveDealOwners(client, transfers.map((t) => t.dealId));
			return {
				ok: true,
				transfers: transfers.map((t) => ({ ...t, ownerName: owners.get(t.dealId) ?? '' })),
				isSupply: appPermission(req, 'transfers.manage_requests', me.isSupply),
			};
		} catch (err) {
			app.log.error({}, `[api/transfers/list] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		}
	});
}
