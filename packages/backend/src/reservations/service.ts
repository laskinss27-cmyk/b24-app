import type { FastifyInstance } from 'fastify';
import { B24ApiError, B24Client } from '../b24/client.js';
import { reservationStoreChat, sendReservationStoreChatMessage } from '../transfers/chats.js';
import {
	moscowDateAt,
	publicReservation,
	reservationStatus,
	trackedFromSnapshot,
	type ReservationRow,
	type ReservationState,
	type TrackedReservation,
} from './model.js';
import { scanReservations } from './scanner.js';
import type { ReservationStore } from './store.js';

const CACHE_MS = 60_000;
const RETRY_MS = 30 * 60_000;
const MAX_TRACKED = 5_000;

function errorText(error: unknown): string {
	return error instanceof B24ApiError ? `${error.code}: ${error.description ?? ''}` : String(error);
}

function safeText(value: string): string {
	return value.replace(/[\[\]]/g, '').trim();
}

function formatQuantity(value: number): string {
	return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(value);
}

function formatDate(value: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'без срока';
	const [year, month, day] = value.split('-');
	return `${day}.${month}.${year}`;
}

function canAttempt(lastAttemptAt: string, now: number): boolean {
	const previous = Date.parse(lastAttemptAt);
	return !Number.isFinite(previous) || now - previous >= RETRY_MS;
}

function groupRows(rows: TrackedReservation[]): Map<string, TrackedReservation[]> {
	const groups = new Map<string, TrackedReservation[]>();
	for (const row of rows) {
		const key = `${row.storeId}:${row.dealId}`;
		groups.set(key, [...(groups.get(key) ?? []), row]);
	}
	return groups;
}

function notificationMessage(app: FastifyInstance, kind: 'request' | 'expiry', rows: TrackedReservation[]): string {
	const first = rows[0]!;
	const lines = rows.slice(0, 30).map((row) => `• ${safeText(row.productName)} — ${formatQuantity(row.quantity)} шт.${row.endDate ? ` (до ${formatDate(row.endDate)})` : ''}`);
	if (rows.length > 30) lines.push(`• ещё ${rows.length - 30} поз.`);
	const link = `https://${app.config.portalDomain}/crm/deal/details/${first.dealId}/`;
	return [
		kind === 'request' ? '📦 Запрос на резерв' : '⏰ Резерв закончился',
		`Сделка #${first.dealId}: ${safeText(first.dealTitle)}`,
		`Ответственный: ${safeText(first.managerName)}`,
		kind === 'request' ? 'Отложите товар:' : 'Верните товар на полки:',
		...lines,
		`[URL=${link}]Открыть сделку[/URL]`,
	].join('\n');
}

export class ReservationService {
	private running: Promise<void> | null = null;
	private lastRefreshMs = 0;

	constructor(private readonly app: FastifyInstance, private readonly store: ReservationStore) {}

	async list(client: B24Client, force = false): Promise<{ rows: ReservationRow[]; scannedAt: string }> {
		await this.refresh(client, force);
		const state = await this.store.read();
		const today = moscowDateAt();
		const priority = { ending_today: 0, active: 1, expired: 2, released: 3 } as const;
		const rows = Object.values(state.items)
			.map((item) => publicReservation(item, today))
			.sort((left, right) => priority[left.status] - priority[right.status]
				|| left.endDate.localeCompare(right.endDate)
				|| right.dealId - left.dealId);
		return { rows, scannedAt: state.lastScanAt };
	}

	async refresh(client: B24Client, force = false): Promise<void> {
		if (!force && Date.now() - this.lastRefreshMs < CACHE_MS) return;
		if (this.running) return this.running;
		this.running = this.performRefresh(client).finally(() => { this.running = null; });
		return this.running;
	}

	private async performRefresh(client: B24Client): Promise<void> {
		const scan = await scanReservations(client);
		const state = await this.store.read();
		const at = new Date().toISOString();
		const today = moscowDateAt(new Date(at));
		const seen = new Set(scan.rows.map((row) => row.key));

		for (const snapshot of scan.rows) {
			const current = state.items[snapshot.key];
			state.items[snapshot.key] = current
				? { ...current, ...snapshot, lastSeenAt: at, endedAt: '' }
				: trackedFromSnapshot(snapshot, at);
		}

		for (const item of Object.values(state.items)) {
			if (seen.has(item.key) || item.endedAt) continue;
			if (!scan.openDealIds.has(item.dealId) || scan.scannedDealIds.has(item.dealId)) item.endedAt = at;
		}

		await this.sendNotifications(client, state, today, at);
		state.lastScanAt = at;
		state.items = Object.fromEntries(Object.values(state.items)
			.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
			.slice(0, MAX_TRACKED)
			.map((item) => [item.key, item]));
		await this.store.write(state);
		this.lastRefreshMs = Date.now();
	}

	private async sendNotifications(client: B24Client, state: ReservationState, today: string, at: string): Promise<void> {
		const now = Date.parse(at);
		const items = Object.values(state.items);
		const requests = items.filter((item) => !item.requestNotifiedAt
			&& !item.endedAt
			&& reservationStatus(item, today) !== 'expired'
			&& canAttempt(item.requestLastAttemptAt, now));
		const expiries = items.filter((item) => !item.expiryNotifiedAt
			&& reservationStatus(item, today) === 'expired'
			&& canAttempt(item.expiryLastAttemptAt, now));
		await this.sendGroups(client, 'request', groupRows(requests), at);
		await this.sendGroups(client, 'expiry', groupRows(expiries), at);
	}

	private async sendGroups(client: B24Client, kind: 'request' | 'expiry', groups: Map<string, TrackedReservation[]>, at: string): Promise<void> {
		for (const rows of groups.values()) {
			const first = rows[0]!;
			const sentField = kind === 'request' ? 'requestNotifiedAt' : 'expiryNotifiedAt';
			const attemptField = kind === 'request' ? 'requestLastAttemptAt' : 'expiryLastAttemptAt';
			const errorField = kind === 'request' ? 'requestNotificationError' : 'expiryNotificationError';
			for (const row of rows) row[attemptField] = at;
			if (!reservationStoreChat(first.storeId, first.storeName)) {
				for (const row of rows) row[errorField] = 'Для склада не настроен чат';
				continue;
			}
			try {
				const sent = await sendReservationStoreChatMessage(client, first.storeId, first.storeName, notificationMessage(this.app, kind, rows));
				if (!sent) throw new Error('Для склада не настроен чат');
				for (const row of rows) {
					row[sentField] = at;
					row[errorField] = '';
				}
				await this.app.operationLog.record({
					area: 'reservations', operation: kind === 'request' ? 'request_notification' : 'expiry_notification', outcome: 'success',
					summary: kind === 'request'
						? `Точка «${first.storeName}» уведомлена о резерве по сделке #${first.dealId}`
						: `Точка «${first.storeName}» уведомлена об окончании резерва по сделке #${first.dealId}`,
					dealId: first.dealId, details: { store: first.storeName, items: rows.length },
				});
			} catch (error) {
				const message = errorText(error);
				for (const row of rows) row[errorField] = message;
				this.app.log.warn({ store: first.storeName, dealId: first.dealId, kind }, `[reservations] notification failed: ${message}`);
				await this.app.operationLog.record({
					area: 'reservations', operation: kind === 'request' ? 'request_notification' : 'expiry_notification', outcome: 'failure',
					summary: `Не удалось уведомить точку «${first.storeName}» по сделке #${first.dealId}: ${message}`,
					dealId: first.dealId, details: { store: first.storeName, items: rows.length },
				});
			}
		}
	}
}
