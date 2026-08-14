import type { FastifyInstance } from 'fastify';
import { B24Client } from '../b24/client.js';
import { unbindReportBuilderMenuPlacement } from '../b24/placement.js';
import { PlacementBodySchema, PlacementQuerySchema, buildReportBuilderContext, extractInstallAuth } from '../handlers/placement-context.js';
import { reportBuilderUser } from '../report-builder/access.js';
import { verifyBitrixRequest } from '../security.js';

export function registerPlacementReportBuilderRoute(app: FastifyInstance): void {
	app.post('/placement/report-builder', async (req, reply) => {
		const parsed = PlacementBodySchema.safeParse(req.body);
		if (!parsed.success) return reply.code(400).send('invalid placement body');
		const query = PlacementQuerySchema.safeParse(req.query);
		const queryData = query.success ? query.data : {};
		const verdict = verifyBitrixRequest(parsed.data, queryData, app.config);
		if (!verdict.ok) return reply.code(403).send('forbidden');
		const auth = extractInstallAuth(parsed.data, queryData);
		if (!auth) return reply.code(403).type('text/html; charset=utf-8').send('<!doctype html><html lang="ru"><body><h1>Нет авторизации</h1></body></html>');
		const client = new B24Client({ auth: { kind: 'oauth', domain: auth.domain, accessToken: auth.accessToken } });
		if (!(await reportBuilderUser(client))) {
			return reply.code(403).type('text/html; charset=utf-8').send('<!doctype html><html lang="ru"><body style="font-family:Arial,sans-serif;padding:32px"><h1>Нет доступа</h1><p>Конструктор отчётов доступен только администраторам и Владимиру Дранишникову.</p></body></html>');
		}
		const cleanup = await unbindReportBuilderMenuPlacement({ client, publicBaseUrl: app.config.publicBaseUrl });
		app.log.info({ status: cleanup.status }, '[placement/report-builder] obsolete menu cleanup');
		const indexHtml = await app.readFrontendIndex();
		if (!indexHtml) return reply.code(503).send('frontend is not built');
		const ctxJson = JSON.stringify(buildReportBuilderContext(parsed.data))
			.replace(/</g, '\\u003c')
			.replace(/>/g, '\\u003e')
			.replace(/&/g, '\\u0026');
		const inject = `
	<script src="//api.bitrix24.com/api/v1/"></script>
	<script>window.__B24_CONTEXT__ = ${ctxJson};</script>
`;
		return reply.code(200).type('text/html; charset=utf-8').send(indexHtml.replace('</head>', `${inject}</head>`));
	});
}
