import type { FastifyInstance } from 'fastify';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { createSupplyTask, supplyTaskUrl, taskLink } from '../b24/supply-task.js';
import type { TransferLine } from '../transfers/model.js';
import type { StoredTransferRequest } from '../transfers/request-model.js';
import { saveTransferRequest } from './transfer-request-storage.js';
import type { CurrentUser } from './transfer-user-access.js';

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function formatTransferLines(lines: TransferLine[]): string {
	return lines.map((line) => `• ${line.name || `#${line.productId}`} × ${line.qty}`).join('\n');
}

export async function createTransferRequestTask(
	app: FastifyInstance,
	client: B24Client,
	request: StoredTransferRequest,
	me: CurrentUser,
): Promise<void> {
	try {
		const isTransfer = request.kind === 'transfer';
		const lines = isTransfer
			? formatTransferLines(request.lines)
			: request.supplyLines.map((line) => `• ${line.name || (line.productId ? `#${line.productId}` : 'позиция')} × ${line.qty}${line.link ? `\n  ${line.link}` : ''}${line.note ? `\n  ${line.note}` : ''}`).join('\n');
		const linkParams = { request: request.id };
		const title = isTransfer ? `Заказ на перемещение #${request.id}` : `Заявка снабжению #${request.id}`;
		const route = isTransfer ? `${request.fromStore} → ${request.toStore}` : `Привезти на: ${request.toStore}`;
		const result = await createSupplyTask(client, {
			title: `${title}: ${isTransfer ? request.fromStore : request.toStore}`,
			description: [
				title,
				route,
				request.note ? `Комментарий: ${request.note}` : '',
				'',
				lines,
				'',
				taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, linkParams, 'supply'), 'Ссылка для снабжения'),
				taskLink(supplyTaskUrl(app.config.portalDomain, app.config.appClientId, linkParams, 'manager'), 'Ссылка для менеджера'),
			].filter(Boolean).join('\n'),
			authorId: me.id,
		});
		if (result.taskId) {
			request.taskId = result.taskId;
			await saveTransferRequest(client, request);
		} else {
			app.log.warn({ requestId: request.id, error: result.error }, '[transfer-requests] supply task was not created');
		}
	} catch (error) {
		app.log.warn({ requestId: request.id, error: errInfo(error) }, '[transfer-requests] supply task sync failed');
	}
}
