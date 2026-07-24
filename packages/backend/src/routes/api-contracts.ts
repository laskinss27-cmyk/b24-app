import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { generateDealContract, getContractContext } from '../deal-contract.js';
import { normalizeDomain } from '../security.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

function errInfo(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error instanceof Error ? error.message : error);
}

export function registerApiContractsRoute(app: FastifyInstance): void {
	const clientFrom = (body: AuthBody): B24Client | null => {
		if (!body.domain || !body.accessToken) return null;
		if (normalizeDomain(body.domain) !== normalizeDomain(app.config.portalDomain)) return null;
		return new B24Client({ auth: { kind: 'oauth', domain: body.domain, accessToken: body.accessToken } });
	};

	app.post('/api/contracts/context', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & { dealId?: unknown };
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(body.dealId);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		try {
			const context = await getContractContext(client, dealId);
			return { ok: true, context };
		} catch (error) {
			app.log.error({ dealId }, `[api/contracts/context] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});

	app.post('/api/contracts/generate', async (req, reply) => {
		const body = (req.body ?? {}) as AuthBody & {
			dealId?: unknown;
			companyId?: unknown;
			vatRate?: unknown;
			contractDate?: unknown;
			contractNumber?: unknown;
			objectType?: unknown;
			objectAddress?: unknown;
		};
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(body.dealId);
		const companyId = Number(body.companyId);
		const vatRate = Number(body.vatRate);
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(companyId) || companyId <= 0) return reply.code(400).send({ ok: false, error: 'bad companyId' });
		if (vatRate !== 5 && vatRate !== 22) return reply.code(400).send({ ok: false, error: 'bad vatRate' });
		try {
			const result = await generateDealContract(client, dealId, {
				companyId,
				vatRate,
				contractDate: String(body.contractDate ?? ''),
				contractNumber: String(body.contractNumber ?? ''),
				objectType: String(body.objectType ?? ''),
				objectAddress: String(body.objectAddress ?? ''),
			});
			app.log.info({ dealId, companyId, contractNumber: result.contractNumber }, '[api/contracts/generate] ok');
			return reply
				.header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
				.header('Content-Disposition', `attachment; filename="${result.filename}"`)
				.header('X-Contract-Number', result.contractNumber)
				.header('Cache-Control', 'no-store')
				.send(result.file);
		} catch (error) {
			app.log.error({ dealId, companyId }, `[api/contracts/generate] failed — ${errInfo(error)}`);
			return reply.code(200).send({ ok: false, error: errInfo(error) });
		}
	});
}
