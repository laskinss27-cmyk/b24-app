import { useEffect, useMemo, useState } from 'react';
import { openDeal } from './bitrix-navigation.js';
import { fetchReservations, type ReservationNotificationStatus, type ReservationRow } from './reservations-api.js';
import { filterAndSortReservations, RESERVATION_STATUS_LABEL, type ReservationSort, type ReservationStatusFilter } from './reservation-view.js';

function formatDate(value: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	return match ? `${match[3]}.${match[2]}.${match[1]}` : 'Без срока';
}

function formatScannedAt(value: string): string {
	if (!value) return '';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

function notificationLabel(value: ReservationNotificationStatus): string {
	if (value === 'sent') return 'отправлено';
	if (value === 'failed') return 'ошибка отправки';
	if (value === 'not_configured') return 'чат не настроен';
	return 'ожидается';
}

export function ReservationsView(): JSX.Element {
	const [rows, setRows] = useState<ReservationRow[]>([]);
	const [search, setSearch] = useState('');
	const [status, setStatus] = useState<ReservationStatusFilter>('all');
	const [sort, setSort] = useState<ReservationSort>('status');
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [scannedAt, setScannedAt] = useState('');
	const [notificationsEnabled, setNotificationsEnabled] = useState(true);

	const load = async (refresh = false): Promise<void> => {
		setLoading(true);
		setError('');
		try {
			const result = await fetchReservations(refresh);
			setRows(result.rows);
			setScannedAt(result.scannedAt);
			setNotificationsEnabled(result.notificationsEnabled);
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => { void load(); }, []);
	const visible = useMemo(() => filterAndSortReservations(rows, search, status, sort), [rows, search, status, sort]);
	const count = (value: ReservationStatusFilter): number => value === 'all' ? rows.length : rows.filter((row) => row.status === value).length;

	return (
		<section className="supply-proto-card supply-reservations-card">
			<div className="supply-proto-card-head supply-reservations-head">
				<div>
					<h2>Резервы товаров</h2>
					<p>{scannedAt ? `Последняя проверка: ${formatScannedAt(scannedAt)}` : 'Данные из резервов сделок Bitrix24.'}</p>
				</div>
				<button type="button" disabled={loading} onClick={() => void load(true)}>{loading ? 'Проверяем…' : 'Обновить'}</button>
			</div>
			<div className="supply-reservation-filters">
				<label><span>Поиск</span><input type="search" value={search} placeholder="Товар, сделка, менеджер или склад" onChange={(event) => setSearch(event.target.value)} /></label>
				<label><span>Статус</span><select value={status} onChange={(event) => setStatus(event.target.value as ReservationStatusFilter)}>
					<option value="all">Все ({count('all')})</option>
					<option value="ending_today">Заканчиваются сегодня ({count('ending_today')})</option>
					<option value="active">Действуют ({count('active')})</option>
					<option value="expired">Истекли ({count('expired')})</option>
					<option value="released">Сняты ({count('released')})</option>
				</select></label>
				<label><span>Сортировка</span><select value={sort} onChange={(event) => setSort(event.target.value as ReservationSort)}>
					<option value="status">По статусу: срочные сначала</option>
					<option value="end_asc">По окончанию: сначала ближайшие</option>
					<option value="end_desc">По окончанию: сначала поздние</option>
					<option value="newest">Сначала новые резервы</option>
				</select></label>
			</div>
			{!notificationsEnabled && <div className="supply-reservation-warning">Фоновая отправка отключена: в конфигурации сервера не задан системный webhook.</div>}
			{error && <div className="supply-reservation-error">{error}</div>}
			<div className="supply-proto-table-wrap">
				<table className="supply-proto-table supply-reservations-table">
					<thead><tr><th>Товар</th><th>Сделка</th><th>Точка</th><th>Кол-во</th><th>Окончание</th><th>Статус</th><th>Уведомления</th></tr></thead>
					<tbody>
						{!loading && visible.length === 0 ? <tr><td colSpan={7} className="empty">{search.trim() || status !== 'all' ? 'По заданным условиям резервов нет.' : 'Резервов пока нет.'}</td></tr> : visible.map((row) => (
							<tr key={row.key}>
								<td><b>{row.productName}</b><small>Товар #{row.productId}</small></td>
								<td><button className="supply-table-document-link" type="button" onClick={() => openDeal(row.dealId)}>{row.dealTitle || `Сделка #${row.dealId}`}</button><small>#{row.dealId} · {row.managerName}</small></td>
								<td>{row.storeName}</td>
								<td>{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(row.quantity)}</td>
								<td>{formatDate(row.endDate)}</td>
								<td><span className={`reservation-status ${row.status}`}>{RESERVATION_STATUS_LABEL[row.status]}</span></td>
								<td className="reservation-notifications"><span>Запрос: {notificationLabel(row.requestNotification)}</span>{(row.status === 'expired' || row.expiryNotification === 'sent' || row.expiryNotification === 'failed') && <span>Окончание: {notificationLabel(row.expiryNotification)}</span>}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{loading && <div className="supply-reservation-loading">Проверяем резервы…</div>}
		</section>
	);
}
