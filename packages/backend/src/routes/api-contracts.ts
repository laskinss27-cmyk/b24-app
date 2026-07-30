import type { FastifyInstance } from 'fastify';
import { B24Client, B24ApiError } from '../b24/client.js';
import { CONTRACT_TEMPLATES, generateDealContract, getContractContext } from '../deal-contract.js';
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
			templateId?: unknown;
			customerKind?: unknown;
			contractDate?: unknown;
			objectAddress?: unknown;
			objectName?: unknown;
			workDuration?: unknown;
			workDurationUnit?: unknown;
		};
		const client = clientFrom(body);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const dealId = Number(body.dealId);
		const companyId = Number(body.companyId);
		const templateId = String(body.templateId ?? '');
		const customerKind = String(body.customerKind ?? '');
		const workDuration = Number(body.workDuration);
		const workDurationUnit = String(body.workDurationUnit ?? '');
		if (!Number.isInteger(dealId) || dealId <= 0) return reply.code(400).send({ ok: false, error: 'bad dealId' });
		if (!Number.isInteger(companyId) || companyId <= 0) return reply.code(400).send({ ok: false, error: 'bad companyId' });
		if (!['universal_work', 'supply', 'design', 'smart_home'].includes(templateId)) return reply.code(400).send({ ok: false, error: 'bad templateId' });
		if (!['company', 'ip', 'person'].includes(customerKind)) return reply.code(400).send({ ok: false, error: 'bad customerKind' });
		const template = CONTRACT_TEMPLATES.find((item) => item.id === templateId);
		if (template?.usesWorkDuration && (!Number.isInteger(workDuration) || workDuration < 1 || workDuration > 3650)) {
			return reply.code(400).send({ ok: false, error: 'bad workDuration' });
		}
		if (template?.usesWorkDuration && workDurationUnit !== 'calendar' && workDurationUnit !== 'working') {
			return reply.code(400).send({ ok: false, error: 'bad workDurationUnit' });
		}
		try {
			const result = await generateDealContract(client, dealId, {
				companyId,
				templateId: templateId as 'universal_work' | 'supply' | 'design' | 'smart_home',
				customerKind: customerKind as 'company' | 'ip' | 'person',
				contractDate: String(body.contractDate ?? ''),
				objectAddress: String(body.objectAddress ?? ''),
				objectName: String(body.objectName ?? ''),
				workDuration: template?.usesWorkDuration ? workDuration : 14,
				workDurationUnit: template?.usesWorkDuration
					? workDurationUnit as 'calendar' | 'working'
					: 'calendar',
			});
			app.log.info({ dealId, companyId, templateId, contractNumber: result.contractNumber }, '[api/contracts/generate] ok');
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
