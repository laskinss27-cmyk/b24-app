import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchStockFormData, openDeal, type StockItem } from './b24.js';
import { StockProductFilter } from './StockProductFilter.js';
import {
	createSupplyReservation, fetchReservationsRegistry, fetchSupplyReservations, lookupReservationDeal, newReservationKey,
	releaseSupplyReservation, reviewReservationRelease, reviewReservationRequest, setSupplyReservationDeal,
	type ReservationRequestView,
} from './reservation-api.js';
import { reservationDisplayNumber, reservationProductSummary } from './supply-reservation-summary.js';

type DraftLine = { productId: number; itemName: string; storeTitle: string; quantity: number };

function localDateTime(value: string): string {
	const date = new Date(value);
	date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
	return date.toISOString().slice(0, 16);
}

function parseDealId(value: string): number | null {
	const id = Number(value.match(/\d+/g)?.at(-1) ?? 0);
	return Number.isInteger(id) && id > 0 ? id : null;
}

function daysLeft(value: string | null): string {
	if (!value) return 'срок не указан';
	const days = Math.ceil((new Date(value).getTime() - Date.now()) / 86_400_000);
	return days < 0 ? `истёк ${Math.abs(days)} дн. назад` : days === 0 ? 'истекает сегодня' : `осталось ${days} дн.`;
}

function statusLabel(request: ReservationRequestView): string {
	if (request.status === 'pending') return 'На согласовании';
	if (request.status === 'rejected') return 'Отклонён';
	return ({ active: 'Активен', shortfall: 'Уменьшен по остатку', released: 'Снят', expired: 'Истёк', consumed: 'Использован' } as Record<string, string>)[request.reservationStatus ?? ''] ?? request.reservationStatus ?? request.status;
}

function statusTone(request: ReservationRequestView): string {
	if (request.status === 'pending') return 'pending';
	if (request.status === 'rejected') return 'rejected';
	if (request.reservationStatus === 'active') return 'active';
	if (request.reservationStatus === 'shortfall') return 'shortfall';
	return 'closed';
}

export function SupplyReservationsView({ readOnly = false }: { readOnly?: boolean } = {}): JSX.Element {
	const [requests, setRequests] = useState<ReservationRequestView[]>([]);
	const [enabled, setEnabled] = useState(false);
	const [canWrite, setCanWrite] = useState(false);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [expires, setExpires] = useState<Record<string, string>>({});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [showCreate, setShowCreate] = useState(false);
	const [stores, setStores] = useState<string[]>([]);
	const [dealInput, setDealInput] = useState('');
	const [dealPreview, setDealPreview] = useState<{ id: number; title: string; managerName: string | null } | null>(null);
	const [purpose, setPurpose] = useState('');
	const [comment, setComment] = useState('');
	const [createExpires, setCreateExpires] = useState(localDateTime(new Date(Date.now() + 7 * 86_400_000).toISOString()));
	const [picked, setPicked] = useState<StockItem | null>(null);
	const [pickedStore, setPickedStore] = useState('');
	const [pickedQty, setPickedQty] = useState(1);
	const [draftLines, setDraftLines] = useState<DraftLine[]>([]);
	const [linkInput, setLinkInput] = useState('');

	const refresh = useCallback(async () => {
		setLoading(true); setError(null);
		try {
			const result = readOnly ? await fetchReservationsRegistry() : await fetchSupplyReservations();
			setEnabled(result.enabled); setCanWrite(result.canWrite); setRequests(result.requests);
			setExpires(Object.fromEntries(result.requests.map((request) => [request.id, localDateTime(request.requestedExpiresAt)])));
		} catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
		finally { setLoading(false); }
	}, [readOnly]);
	useEffect(() => {
		void refresh();
		if (!readOnly) void fetchStockFormData().then((result) => setStores(result.stores)).catch(() => setStores([]));
	}, [readOnly, refresh]);
	const selected = useMemo(() => requests.find((request) => request.id === selectedId) ?? null, [requests, selectedId]);

	const review = async (request: ReservationRequestView, decision: 'approve' | 'reject'): Promise<void> => {
		const reason = decision === 'reject' ? window.prompt('Причина отказа:', '') : '';
		if (decision === 'reject' && !reason?.trim()) return;
		setBusy(`request-${request.id}`); setError(null);
		try {
			await reviewReservationRequest({ requestId: request.id, decision, idempotencyKey: newReservationKey(), ...(decision === 'approve'
				? { approvedExpiresAt: new Date(expires[request.id] ?? request.requestedExpiresAt).toISOString() }
				: { reason: reason!.trim() }) });
			await refresh();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const decideRelease = async (request: ReservationRequestView, decision: 'approve' | 'reject'): Promise<void> => {
		if (!request.releaseRequestId) return;
		const reason = decision === 'reject' ? window.prompt('Причина отказа в снятии:', '') ?? '' : '';
		setBusy(`release-${request.releaseRequestId}`); setError(null);
		try { await reviewReservationRelease({ releaseRequestId: request.releaseRequestId, decision, reason, idempotencyKey: newReservationKey() }); await refresh(); }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const lookupDeal = async (): Promise<void> => {
		const dealId = parseDealId(dealInput);
		if (!dealId) { setDealPreview(null); setError('Укажите номер или ссылку на сделку'); return; }
		setBusy('deal-lookup'); setError(null);
		try { setDealPreview(await lookupReservationDeal(dealId)); }
		catch (failure) { setDealPreview(null); setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const addLine = (): void => {
		if (!picked || !pickedStore || pickedQty <= 0) return;
		setDraftLines((current) => {
			const existing = current.find((line) => line.productId === picked.productId && line.storeTitle === pickedStore);
			return existing ? current.map((line) => line === existing ? { ...line, quantity: line.quantity + pickedQty } : line) : [...current, { productId: picked.productId, itemName: picked.name, storeTitle: pickedStore, quantity: pickedQty }];
		});
		setPicked(null); setPickedQty(1);
	};

	const create = async (): Promise<void> => {
		if (!draftLines.length) return setError('Добавьте хотя бы одну позицию');
		const dealId = dealPreview?.id ?? null;
		if (dealId == null && !window.confirm('Резерв без сделки заблокирует товар для всех продаж и не спишется автоматически. Создать?')) return;
		setBusy('create'); setError(null);
		try {
			const result = await createSupplyReservation({ dealId, expiresAt: new Date(createExpires).toISOString(), purpose, comment, requestKey: newReservationKey(), lines: draftLines });
			if (result.warnings.length) setNotice(result.warnings.join('. '));
			setShowCreate(false); setDealInput(''); setDealPreview(null); setPurpose(''); setComment(''); setDraftLines([]); await refresh();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const changeDeal = async (request: ReservationRequestView, nextDealId: number | null): Promise<void> => {
		if (!request.reservationId) return;
		if (nextDealId == null && !window.confirm('Отвязать резерв от сделки? Он продолжит блокировать товар для всех продаж.')) return;
		setBusy(`link-${request.id}`); setError(null); setNotice(null);
		try {
			if (nextDealId != null) await lookupReservationDeal(nextDealId);
			const warnings = await setSupplyReservationDeal(request.reservationId, nextDealId, newReservationKey());
			if (warnings.length) setNotice(warnings.join('. '));
			setLinkInput(''); await refresh();
		} catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	const directRelease = async (request: ReservationRequestView): Promise<void> => {
		if (!request.reservationId) return;
		const reason = window.prompt('Причина снятия резерва:', '') ?? '';
		if (!window.confirm('Снять резерв сейчас? Товар снова станет доступен для продаж.')) return;
		setBusy(`direct-release-${request.id}`); setError(null);
		try { await releaseSupplyReservation(request.reservationId, reason, newReservationKey()); await refresh(); }
		catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
		finally { setBusy(''); }
	};

	if (loading) return <div className="supply-proto-card empty">Загрузка резервов…</div>;
	if (!enabled) return <div className="supply-proto-card empty">Механизм резервирования пока выключен.</div>;
	return <div className="supply-reservations">
		{error && <div className="supply-proto-notice"><span>{error}</span><button type="button" onClick={() => setError(null)}>Закрыть</button></div>}
		{notice && <div className="supply-proto-notice"><span>{notice}</span><button type="button" onClick={() => setNotice(null)}>Закрыть</button></div>}
		<div className="supply-reservation-toolbar"><div><b>Все резервы</b><span>{requests.length} записей, включая обработанные</span></div>{!readOnly && <div className="supply-proto-actions"><button className="primary" type="button" disabled={!canWrite} onClick={() => setShowCreate((value) => !value)}>{showCreate ? 'Закрыть создание' : 'Создать резерв'}</button></div>}</div>
		{!readOnly && showCreate && <CreateReservationForm busy={busy} stores={stores} dealInput={dealInput} dealPreview={dealPreview} purpose={purpose} comment={comment} expires={createExpires} picked={picked} pickedStore={pickedStore} pickedQty={pickedQty} lines={draftLines} onDealInput={(value) => { setDealInput(value); setDealPreview(null); }} onLookup={() => void lookupDeal()} onPurpose={setPurpose} onComment={setComment} onExpires={setCreateExpires} onPicked={setPicked} onPickedStore={setPickedStore} onPickedQty={setPickedQty} onAdd={addLine} onRemove={(index) => setDraftLines((current) => current.filter((_line, lineIndex) => lineIndex !== index))} onCancel={() => setShowCreate(false)} onCreate={() => void create()} />}
		<section className="supply-proto-card supply-reservation-registry">
			<div className="supply-reservation-registry-columns" aria-hidden="true"><span>Номер</span><span>Товар / количество</span><span>Сделка</span><span>Срок</span><span>Статус</span><span></span></div>
			{!requests.length && <div className="empty">Резервов пока нет.</div>}
			{requests.map((request) => <ReservationCard key={request.id} request={request} selected={selected?.id === request.id} canWrite={canWrite} busy={busy} expires={expires[request.id] ?? ''} linkInput={linkInput} onToggle={() => setSelectedId(selectedId === request.id ? null : request.id)} onExpires={(value) => setExpires((current) => ({ ...current, [request.id]: value }))} onReview={(decision) => void review(request, decision)} onReleaseDecision={(decision) => void decideRelease(request, decision)} onLinkInput={setLinkInput} onChangeDeal={(dealId) => void changeDeal(request, dealId)} onRelease={() => void directRelease(request)} />)}
		</section>
	</div>;
}

function CreateReservationForm(props: { busy: string; stores: string[]; dealInput: string; dealPreview: { id: number; title: string; managerName: string | null } | null; purpose: string; comment: string; expires: string; picked: StockItem | null; pickedStore: string; pickedQty: number; lines: DraftLine[]; onDealInput: (v: string) => void; onLookup: () => void; onPurpose: (v: string) => void; onComment: (v: string) => void; onExpires: (v: string) => void; onPicked: (v: StockItem | null) => void; onPickedStore: (v: string) => void; onPickedQty: (v: number) => void; onAdd: () => void; onRemove: (index: number) => void; onCancel: () => void; onCreate: () => void }): JSX.Element {
	return <section className="supply-proto-card supply-reservation-create">
		<header className="supply-reservation-create-head"><div><span className="supply-reservation-create-eyebrow">Новый документ</span><h2>Резерв товара</h2><p>Создаётся снабжением и сразу становится активным.</p></div><span className="supply-reservation-create-badge">Сделка необязательна</span></header>
		<div className="supply-reservation-create-body">
			<section className="supply-reservation-create-section">
				<div className="supply-reservation-create-section-head"><div><b>Привязка и условия</b><span>Укажите сделку, срок и назначение резерва</span></div><span>01</span></div>
				<div className="supply-reservation-create-fields">
					<label className="wide"><span>Сделка</span><div className="supply-reservation-deal-control"><input placeholder="Номер или ссылка на сделку" value={props.dealInput} onChange={(event) => props.onDealInput(event.target.value)} onBlur={() => { if (parseDealId(props.dealInput) && !props.dealPreview) props.onLookup(); }} /><button type="button" disabled={props.busy === 'deal-lookup'} onClick={props.onLookup}>{props.busy === 'deal-lookup' ? 'Ищу…' : 'Подтянуть'}</button></div><small>Можно оставить пустым и привязать сделку позднее.</small></label>
					{props.dealPreview && <div className="supply-reservation-deal-preview"><span>Сделка найдена</span><button type="button" className="supply-order-deal-link" onClick={() => openDeal(props.dealPreview!.id)}>{props.dealPreview.title} · №{props.dealPreview.id}</button>{props.dealPreview.managerName && <small>Менеджер: {props.dealPreview.managerName}</small>}</div>}
					<label><span>Резерв до</span><input type="datetime-local" value={props.expires} onChange={(event) => props.onExpires(event.target.value)} /></label>
					<label><span>Основание</span><input maxLength={500} value={props.purpose} onChange={(event) => props.onPurpose(event.target.value)} placeholder="Для чего резервируем товар" /></label>
					<label className="wide"><span>Комментарий</span><textarea maxLength={1000} rows={3} value={props.comment} onChange={(event) => props.onComment(event.target.value)} placeholder="Дополнительная информация по резерву" /></label>
				</div>
			</section>
			<section className="supply-reservation-create-section">
				<div className="supply-reservation-create-section-head"><div><b>Позиции резерва</b><span>Найдите товар, затем укажите склад и количество</span></div><span>02</span></div>
				<div className="supply-reservation-product-picker"><StockProductFilter value={props.picked} onChange={props.onPicked} placeholder="Поиск по названию, артикулу или ID" resultsMode="panel" /></div>
				<div className="supply-reservation-create-controls"><label><span>Склад</span><select value={props.pickedStore} onChange={(event) => props.onPickedStore(event.target.value)}><option value="">Выберите склад</option>{props.stores.map((store) => <option key={store}>{store}</option>)}</select></label><label><span>Количество</span><input type="number" min="0.001" step="any" value={props.pickedQty} onChange={(event) => props.onPickedQty(Number(event.target.value))} /></label><button type="button" disabled={!props.picked || !props.pickedStore || props.pickedQty <= 0} onClick={props.onAdd}>+ Добавить позицию</button></div>
				{props.lines.length > 0 && <div className="supply-reservation-create-lines"><div className="supply-reservation-create-lines-head"><b>Добавлено в резерв</b><span>{props.lines.length} поз.</span></div>{props.lines.map((line, index) => <div key={`${line.productId}-${line.storeTitle}`}><span><b>{line.itemName}</b><small>{line.storeTitle}</small></span><strong>{line.quantity} шт.</strong><button type="button" aria-label={`Удалить ${line.itemName}`} title="Удалить позицию" onClick={() => props.onRemove(index)}>×</button></div>)}</div>}
			</section>
		</div>
		<footer className="supply-reservation-create-footer"><span>{props.lines.length ? `К созданию: ${props.lines.length} поз.` : 'Добавьте хотя бы одну позицию'}</span><div><button type="button" onClick={props.onCancel}>Отмена</button><button className="primary" type="button" disabled={props.busy === 'create' || !props.lines.length} onClick={props.onCreate}>{props.busy === 'create' ? 'Создаю…' : 'Создать резерв'}</button></div></footer>
	</section>;
}

function ReservationCard({ request, selected, canWrite, busy, expires, linkInput, onToggle, onExpires, onReview, onReleaseDecision, onLinkInput, onChangeDeal, onRelease }: { request: ReservationRequestView; selected: boolean; canWrite: boolean; busy: string; expires: string; linkInput: string; onToggle: () => void; onExpires: (v: string) => void; onReview: (v: 'approve' | 'reject') => void; onReleaseDecision: (v: 'approve' | 'reject') => void; onLinkInput: (v: string) => void; onChangeDeal: (v: number | null) => void; onRelease: () => void }): JSX.Element {
	const effectiveExpiresAt = request.approvedExpiresAt ?? request.requestedExpiresAt;
	return <article className={`supply-reservation-card${selected ? ' is-open' : ''}`}>
		<button type="button" className="supply-reservation-summary" aria-expanded={selected} onClick={onToggle}>
			<span className="supply-reservation-summary-id">{reservationDisplayNumber(request)}</span>
			<span className="supply-reservation-summary-product" title={reservationProductSummary(request)}>{reservationProductSummary(request)}</span>
			<span className="supply-reservation-summary-deal">{request.dealId ? `Сделка №${request.dealId}` : 'Без сделки'}</span>
			<span className="supply-reservation-summary-term">{daysLeft(effectiveExpiresAt)}</span>
			<span className={`supply-reservation-status ${statusTone(request)}`}>{statusLabel(request)}</span>
			<span className="supply-reservation-chevron" aria-hidden="true">{selected ? '▲' : '▼'}</span>
		</button>
		{selected && <div className="supply-reservation-details">
			<div className="supply-reservation-meta">
				<div><b>Создан:</b> {new Date(request.requestedAt).toLocaleString('ru-RU')}</div>
				<div><b>Инициатор:</b> {request.requestedByName ?? `#${request.requestedBy}`}</div>
				<div><b>Срок:</b> {new Date(effectiveExpiresAt).toLocaleString('ru-RU')} · {daysLeft(effectiveExpiresAt)}</div>
				<div><b>Сделка:</b> {request.dealId ? (request.dealTitle ?? `№${request.dealId}`) : 'не привязана'}</div>
				{request.dealManagerName && <div><b>Менеджер сделки:</b> {request.dealManagerName}</div>}
				{request.reviewedAt && <div><b>Обработан:</b> {new Date(request.reviewedAt).toLocaleString('ru-RU')} · {request.reviewedByName ?? (request.reviewedBy ? `#${request.reviewedBy}` : '—')}</div>}
				{request.rejectionReason && <div><b>Причина отказа:</b> {request.rejectionReason}</div>}
				{request.purpose && <div className="supply-reservation-meta-wide"><b>Основание:</b> {request.purpose}</div>}
				{request.comment && <div className="supply-reservation-meta-wide"><b>Комментарий:</b> {request.comment}</div>}
			</div>
			{request.dealId && <div><button type="button" className="supply-order-deal-link" onClick={() => openDeal(request.dealId!)}>Открыть сделку №{request.dealId}</button></div>}
			<div className="supply-reservation-lines">{request.lines.map((line) => <div key={line.id}><span><b>{line.itemName}</b><small>{line.erpWarehouseName}</small></span><strong>{line.activeQuantity !== '0' ? line.activeQuantity : line.quantity} шт.</strong></div>)}</div>
			{canWrite && request.status === 'pending' && <div className="supply-reservation-actions"><label><span>Срок резерва</span><input type="datetime-local" value={expires} disabled={Boolean(busy)} onChange={(event) => onExpires(event.target.value)} /></label><button type="button" disabled={Boolean(busy)} onClick={() => onReview('reject')}>Отклонить</button><button className="primary" type="button" disabled={Boolean(busy)} onClick={() => onReview('approve')}>Одобрить целиком</button></div>}
			{canWrite && request.releaseRequestStatus === 'pending' && <div className="supply-reservation-actions"><span className="supply-reservation-release-note">Запрошено досрочное снятие.</span><button type="button" disabled={Boolean(busy)} onClick={() => onReleaseDecision('reject')}>Оставить</button><button className="primary danger" type="button" disabled={Boolean(busy)} onClick={() => onReleaseDecision('approve')}>Снять</button></div>}
			{canWrite && request.reservationId && ['active', 'shortfall'].includes(request.reservationStatus ?? '') && <div className="supply-reservation-actions"><input placeholder="Новый № сделки / ссылка" value={linkInput} onChange={(event) => onLinkInput(event.target.value)} /><button type="button" disabled={!parseDealId(linkInput) || Boolean(busy)} onClick={() => onChangeDeal(parseDealId(linkInput))}>{request.dealId ? 'Заменить сделку' : 'Привязать сделку'}</button>{request.dealId && <button type="button" disabled={Boolean(busy)} onClick={() => onChangeDeal(null)}>Отвязать</button>}<button type="button" className="danger" disabled={Boolean(busy)} onClick={onRelease}>Снять резерв</button></div>}
			{(request.releaseRequests ?? []).length > 0 && <div className="supply-reservation-history"><b>Запросы снятия</b>{request.releaseRequests!.map((release) => <div key={release.id}>{new Date(release.requestedAt).toLocaleString('ru-RU')} · {request.actorNames?.[release.requestedBy] ?? `#${release.requestedBy}`} · {release.status}{release.requestedReason ? ` · ${release.requestedReason}` : ''}{release.reviewedAt ? ` · обработан ${new Date(release.reviewedAt).toLocaleString('ru-RU')}` : ''}{release.decisionReason ? ` · ${release.decisionReason}` : ''}</div>)}</div>}
			{(request.events ?? []).length > 0 && <div className="supply-reservation-history"><b>История</b>{request.events!.map((event) => <div key={event.id}>{new Date(event.occurredAt).toLocaleString('ru-RU')} · {event.eventType} · {request.actorNames?.[event.actorId] ?? `#${event.actorId}`}{event.quantity ? ` · ${event.quantity} шт.` : ''}{event.fromDealId || event.toDealId ? ` · ${event.fromDealId ? `№${event.fromDealId}` : 'без сделки'} → ${event.toDealId ? `№${event.toDealId}` : 'без сделки'}` : ''}</div>)}</div>}
		</div>}
	</article>;
}
