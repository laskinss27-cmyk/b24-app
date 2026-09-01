import type { FastifyInstance } from 'fastify';
import { appPermission } from '../access-policy.js';
import { B24ApiError, type B24Client } from '../b24/client.js';
import { TRANSFERS_ENTITY } from '../b24/placement.js';
import { ErpClient } from '../erp/client.js';
import { completeTransferFromTransit } from '../erp/operations.js';
import {
	newTransferData,
	sameTransferQuantities,
	transferLineMap,
	type TransferData,
	type TransferLine,
} from '../transfers/model.js';
import { validateTransferReservation } from './transfer-reservation-service.js';
import { loadTransfer, loadTransfers, saveTransferData } from './transfer-storage.js';
import { currentUser } from './transfer-user-access.js';

interface AuthBody {
	domain?: string;
	accessToken?: string;
}

type TransferClientFrom = (body: AuthBody) => B24Client | null;

function errInfo(err: unknown): string {
	return err instanceof B24ApiError ? `${err.code}: ${err.description ?? ''}` : String(err);
}

export function registerTransferPostRoute(
	app: FastifyInstance,
	clientFrom: TransferClientFrom,
	operationLocks: Set<string>,
): void {
	// Снабжение проводит основной прием и оформляет расхождения отдельными завершенными корректировками.
	app.post('/api/transfers/post', async (req, reply) => {
		const b = (req.body ?? {}) as AuthBody & { id?: unknown };
		const client = clientFrom(b);
		if (!client) return reply.code(403).send({ ok: false, error: 'bad auth / domain' });
		const id = Number(b.id);
		if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ ok: false, error: 'bad id' });
		const erp = ErpClient.fromEnv();
		if (!erp) return reply.code(503).send({ ok: false, error: 'ядро недоступно (нет ERPNEXT_URL/TOKEN)' });
		const lockKey = `post:${id}`;
		if (operationLocks.has(lockKey)) return reply.code(409).send({ ok: false, error: 'проведение этого перемещения уже выполняется' });
		operationLocks.add(lockKey);
		try {
			const [doc, me] = await Promise.all([loadTransfer(client, id), currentUser(client)]);
			if (!doc) return reply.code(404).send({ ok: false, error: 'перемещение не найдено' });
			if (!appPermission(req, 'transfers.post', me.isSupply)) {
				return reply.code(403).send({ ok: false, error: 'проводить перемещение может только снабжение' });
			}
			if (doc.status !== 'accepted') return reply.code(409).send({ ok: false, error: `нельзя провести из статуса ${doc.status}` });
			if (!sameTransferQuantities(doc.lines, doc.acceptedLines)) {
				return reply.code(409).send({ ok: false, error: 'принятое количество не совпадает с документом — сначала скорректируй количество' });
			}
			const shippedLines = doc.shippedLines.length ? doc.shippedLines : doc.lines;
			const shippedMapForValidation = transferLineMap(shippedLines);
			const extraLines = doc.lines
				.map((line) => ({ ...line, qty: Math.max(line.qty - (shippedMapForValidation.get(line.productId)?.qty ?? 0), 0) }))
				.filter((line) => line.qty > 0);
			if (extraLines.length) await validateTransferReservation(erp, client, id, doc.fromStore, extraLines, app.reservationRuntime);
			const did = Number(doc.dealId) || 0;
			const completion = await completeTransferFromTransit(erp, {
				transferId: id,
				shippedLines,
				finalLines: doc.lines,
				fromStore: doc.fromStore,
				toStore: doc.toStore,
				...(did ? { dealId: did } : {}),
				...(doc.supplyRequest ? { supplyRequest: doc.supplyRequest } : {}),
				...(doc.supplyRequestKey ? { supplyRequestKey: doc.supplyRequestKey } : {}),
				...(doc.purchaseOrder ? { purchaseOrder: doc.purchaseOrder } : {}),
			});
			const shippedMap = transferLineMap(shippedLines);
			const nameByProduct = new Map([...shippedLines, ...doc.lines].map((line) => [line.productId, line.name]));
			const existingCorrections = (await loadTransfers(client)).filter((transfer) => transfer.correctionOf === id);
			const correctionIds: number[] = [];
			for (const correction of completion.corrections) {
				let stored = existingCorrections.find((transfer) => transfer.correctionKind === correction.kind);
				if (!stored) {
					const lines: TransferLine[] = correction.lines.map((line) => ({
						...line,
						name: nameByProduct.get(line.productId) ?? `#${line.productId}`,
					}));
					const shortage = correction.kind === 'shortage_return';
					const fromStore = shortage ? 'Транзит' : doc.fromStore;
					const toStore = shortage ? doc.fromStore : doc.toStore;
					const correctionData: TransferData = {
						...newTransferData({
							supplyRequest: doc.supplyRequest,
							supplyRequestKey: doc.supplyRequestKey,
							purchaseOrder: doc.purchaseOrder,
							dealId: doc.dealId,
							fromStore,
							toStore,
							lines,
							createdAt: new Date().toISOString(),
							createdById: me.id,
							createdByName: me.name,
						}),
						status: 'posted',
						collectedLines: lines,
						shippedLines: lines,
						acceptedLines: lines,
						receiveEntry: correction.name,
						receivedLines: lines,
						correctionOf: id,
						correctionKind: correction.kind,
						history: [{
							at: new Date().toISOString(), status: 'posted', byId: me.id, byName: me.name, action: 'posted',
							note: `${shortage ? 'Возврат недовоза' : 'Перенос излишка'} по перемещению #${id}; Stock Entry ${correction.name}`,
						}],
					};
					const itemName = `Корректировка #${id}: ${fromStore} → ${toStore}`;
					const added = await client.call<number | { id?: number }>('entity.item.add', {
						ENTITY: TRANSFERS_ENTITY, NAME: itemName, DETAIL_TEXT: JSON.stringify(correctionData),
					});
					const correctionId = typeof added === 'number' ? added : Number((added as { id?: number })?.id ?? 0);
					if (!correctionId) throw new Error('entity.item.add не вернул id корректировки');
					stored = { id: correctionId, name: itemName, ...correctionData };
				}
				correctionIds.push(stored.id);
			}
			const correctionText = doc.lines
				.map((line) => {
					const sent = shippedMap.get(line.productId)?.qty ?? 0;
					return Math.abs(sent - line.qty) > 0.000001 ? `${line.name || `#${line.productId}`}: ${sent} → ${line.qty}` : '';
				})
				.filter(Boolean)
				.join(', ');
			const now = new Date().toISOString();
			const data: TransferData = {
				...doc,
				status: 'posted',
				receiveEntry: completion.receiveEntry,
				receivedLines: doc.lines,
				shortageLines: [],
				shortageReturnEntry: null,
				correctionIds,
				history: [...doc.history, {
					at: now, status: 'posted', byId: me.id, byName: me.name, action: 'posted',
					note: `${completion.receiveEntry ? `Stock Entry ${completion.receiveEntry}` : 'Основное перемещение закрыто без принятого количества'}${correctionText ? `; корректировка: ${correctionText}` : ''}`,
				}],
			};
			await saveTransferData(client, id, doc.name, data);
			app.log.info({ id, receiveEntry: completion.receiveEntry, correctionIds }, '[api/transfers/post] ok');
			return { ok: true, transfer: { id, name: doc.name, ...data } };
		} catch (err) {
			app.log.error({ id }, `[api/transfers/post] failed — ${errInfo(err)}`);
			return reply.code(200).send({ ok: false, error: errInfo(err) });
		} finally {
			operationLocks.delete(lockKey);
		}
	});
}
