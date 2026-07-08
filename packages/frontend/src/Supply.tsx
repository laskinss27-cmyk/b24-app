import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import { fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS, fetchSupplyOrders, type SupplyOrderItem, type SupplyOrderRow } from './b24.js';

type SectionKey = 'orders' | 'logistics' | 'purchase' | 'payment' | 'stock' | 'reports';
const SECTIONS: Array<{ key: SectionKey; title: string; group: string }> = [
	{ key: 'orders', title: 'Заявки', group: 'Операции' },
	{ key: 'logistics', title: 'Логистика', group: 'Операции' },
	{ key: 'purchase', title: 'Закупки', group: 'Операции' },
	{ key: 'payment', title: 'Согласование оплат', group: 'Операции' },
	{ key: 'stock', title: 'Документы склада', group: 'Склад' },
	{ key: 'reports', title: 'Отчеты', group: 'Аналитика' },
];

const MOCK_ORDERS: SupplyOrderRow[] = [
	{ name: 'MAT-MR-2026-0001', dealId: '556', dealTitle: 'Монтаж видеонаблюдения', date: '2026-04-04', status: 'Pending', closed: false, items: [
		{ productId: 104, itemName: 'Блок питания 12В 5А', qty: 4, note: '', stocks: { 'ЦС': 0, 'Парнас': 0, 'Девяткино': 0 } },
		{ productId: 103, itemName: 'Видеорегистратор 8-канальный', qty: 1, note: 'нужен новый, в пленке', stocks: { 'Офис': 4, 'Парнас': 0 } },
		{ productId: 301, itemName: 'IP-камера 4 Мп CTV-IPB2028', qty: 6, note: '', stocks: { 'Парнас': 2, 'Офис': 1, 'Девяткино': 0, 'Богатырский': 0 } },
	] },
	{ name: 'MAT-MR-2026-0002', dealId: '553', dealTitle: 'СКУД офис', date: '2026-04-03', status: 'Pending', closed: false, items: [
		{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, note: '', stocks: {} },
	] },
	{ name: 'MAT-MR-2026-0003', dealId: '551', dealTitle: 'Камеры ТТ Богатырский', date: '2026-04-02', status: 'Ordered', closed: true, items: [
		{ productId: 301, itemName: 'Видеокамера CTV-IPB2028', qty: 4, note: '', stocks: { 'ЦС': 20, 'Девяткино': 6 } },
	] },
];

const STUB: Record<Exclude<SectionKey, 'orders'>, { title: string; note: string }> = {
	logistics: { title: 'Логистика', note: 'Перемещения между складами через транзит. Раздел подключим после утверждения потока заявок.' },
	purchase: { title: 'Закупки', note: 'Закупки по дефициту из заявок снабжения. Здесь будут поставщики, счета и статусы закупа.' },
	payment: { title: 'Согласование оплат', note: 'Согласование счетов через смарт-процесс Б24 после готовности процесса у интегратора.' },
	stock: { title: 'Документы склада', note: 'Ручные складские документы: перемещение, списание, оприходование, возвраты и движение товара.' },
	reports: { title: 'Отчеты', note: 'Остатки, залежалость, движение товара и контроль заявок по срокам.' },
};

type DecisionKind = 'transfer' | 'purchase';
interface Decision {
	id: string;
	productId: number;
	qty: number;
	kind: DecisionKind;
	warehouse?: string;
}
type DecisionMap = Record<string, Decision[]>;
type DraftInput = Record<string, { qty: number; kind: DecisionKind; warehouse: string }>;

const plural = (n: number, one: string, few: string, many: string): string => {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
	return many;
};

const statusLabel = (status: string, closed: boolean): string => {
	if (closed) return 'закрыта';
	if (/ordered/i.test(status)) return 'заказано';
	if (/pending/i.test(status)) return 'новая';
	return status || 'в работе';
};

const itemKey = (orderName: string, productId: number, index: number): string => `${orderName}:${productId}:${index}`;
const stockEntries = (item: SupplyOrderItem): Array<[string, number]> =>
	Object.entries(item.stocks ?? {}).filter(([, qty]) => Number(qty) > 0).sort((a, b) => b[1] - a[1]);

function OrdersList({ orders, loading, selectedName, onPreview, onOpen }: {
	orders: SupplyOrderRow[];
	loading: boolean;
	selectedName: string | null;
	onPreview: (order: SupplyOrderRow) => void;
	onOpen: (order: SupplyOrderRow) => void;
}): JSX.Element {
	return (
		<section className="supply-card supply-orders">
			<div className="supply-card-head">
				<div>
					<h2>Очередь заявок</h2>
					<p>Клик по заявке открывает рабочее окно распределения.</p>
				</div>
				<span className="supply-muted">обновляется из ядра</span>
			</div>
			<div className="supply-table supply-orders-table">
				<div className="supply-tr supply-th">
					<span>Заявка</span><span>Сделка</span><span>Позиций</span><span>Статус</span><span>Дата</span>
				</div>
				{loading && <div className="supply-empty">Загрузка заявок из ядра...</div>}
				{!loading && !orders.length && <div className="supply-empty">Заявок пока нет.</div>}
				{orders.map((order) => (
					<button
						key={order.name}
						className={`supply-tr supply-order-row ${selectedName === order.name ? 'is-selected' : ''}`}
						onMouseEnter={() => onPreview(order)}
						onFocus={() => onPreview(order)}
						onClick={() => onOpen(order)}
						type="button"
					>
						<span><b>{order.name}</b><small>{order.date}</small></span>
						<span><b>{order.dealTitle || `Сделка #${order.dealId}`}</b><small>#{order.dealId}</small></span>
						<span>{order.items.length} {plural(order.items.length, 'позиция', 'позиции', 'позиций')}</span>
						<span><i className={`supply-status ${order.closed ? 'done' : 'active'}`}>{statusLabel(order.status, order.closed)}</i></span>
						<span>{order.date || '-'}</span>
					</button>
				))}
			</div>
		</section>
	);
}

function PreviewPanel({ order }: { order: SupplyOrderRow | null }): JSX.Element {
	if (!order) {
		return (
			<aside className="supply-card supply-preview">
				<h2>Быстрый просмотр</h2>
				<p className="supply-muted">Наведи на заявку, чтобы увидеть состав.</p>
			</aside>
		);
	}
	return (
		<aside className="supply-card supply-preview">
			<div className="supply-preview-title">
				<div>
					<h2>{order.name}</h2>
					<p>{order.dealTitle || `Сделка #${order.dealId}`}</p>
				</div>
				<i className={`supply-status ${order.closed ? 'done' : 'active'}`}>{statusLabel(order.status, order.closed)}</i>
			</div>
			<div className="supply-preview-meta">
				<span>Сделка #{order.dealId}</span>
				<span>{order.date || 'без даты'}</span>
				<span>{order.items.length} {plural(order.items.length, 'позиция', 'позиции', 'позиций')}</span>
			</div>
			<div className="supply-preview-items">
				{order.items.map((item, index) => {
					const stocks = stockEntries(item);
					return (
						<div key={`${item.productId}-${index}`} className="supply-preview-item">
							<b>{item.itemName || `#${item.productId}`}</b>
							<span>нужно {item.qty} шт</span>
							<small>{stocks.length ? `есть ${stocks.reduce((a, [, q]) => a + q, 0)} на ${stocks.length} ${plural(stocks.length, 'складе', 'складах', 'складах')}` : 'нет на складах'}</small>
						</div>
					);
				})}
			</div>
			<p className="supply-preview-hint">Рабочее окно открывается кликом по заявке в списке.</p>
		</aside>
	);
}

function OrderDetail({ order, decisions, drafts, onBack, setDraft, addDecision, removeDecision, createDocs }: {
	order: SupplyOrderRow;
	decisions: DecisionMap;
	drafts: DraftInput;
	onBack: () => void;
	setDraft: (key: string, patch: Partial<DraftInput[string]>) => void;
	addDecision: (key: string, item: SupplyOrderItem, index: number) => void;
	removeDecision: (key: string, id: string) => void;
	createDocs: () => void;
}): JSX.Element {
	const totals = order.items.reduce((acc, item, index) => {
		const key = itemKey(order.name, item.productId, index);
		const used = (decisions[key] ?? []).reduce((a, d) => a + d.qty, 0);
		return { qty: acc.qty + item.qty, used: acc.used + used };
	}, { qty: 0, used: 0 });
	const allDone = totals.qty > 0 && totals.used >= totals.qty;

	return (
		<div className="supply-main supply-detail">
			<header className="supply-top">
				<div>
					<button className="supply-link" type="button" onClick={onBack}>Назад к заявкам</button>
					<h1>{order.name} · {order.dealTitle || `Сделка #${order.dealId}`}</h1>
					<p>Сделка #{order.dealId} · {order.date || 'без даты'} · решения добавляются деревом под основной строкой</p>
				</div>
				<button className="supply-primary" type="button" disabled={!allDone} onClick={createDocs}>Создать документы</button>
			</header>

			<section className="supply-card supply-summary">
				<div>
					<span>Распределено</span>
					<b>{totals.used} из {totals.qty} шт</b>
				</div>
				<div>
					<span>Позиций</span>
					<b>{order.items.length}</b>
				</div>
				<div>
					<span>Статус</span>
					<b>{allDone ? 'готово к документам' : 'есть остатки к выбору'}</b>
				</div>
			</section>

			<section className="supply-card supply-detail-table">
				<div className="supply-detail-head">
					<span>Позиция</span><span>Осталось</span><span>Остатки</span><span>Кол-во</span><span>Действие</span><span>Склад</span><span></span>
				</div>
				{order.items.map((item, index) => {
					const key = itemKey(order.name, item.productId, index);
					const rows = decisions[key] ?? [];
					const used = rows.reduce((a, d) => a + d.qty, 0);
					const remaining = Math.max(item.qty - used, 0);
					const stocks = stockEntries(item);
					const draft = drafts[key] ?? { qty: remaining || 1, kind: stocks.length ? 'transfer' : 'purchase', warehouse: stocks[0]?.[0] ?? '' };
					return (
						<div key={key} className="supply-item-block">
							<div className={`supply-detail-row ${remaining === 0 ? 'is-done' : ''}`}>
								<div>
									<b>{item.itemName || `#${item.productId}`}</b>
									<small>{item.note || 'основная строка: остаток к распределению'}</small>
								</div>
								<strong>{remaining} из {item.qty}</strong>
								<span>{stocks.length ? `есть ${stocks.reduce((a, [, q]) => a + q, 0)} на ${stocks.length} ${plural(stocks.length, 'складе', 'складах', 'складах')}` : 'нет на складах'}</span>
								{remaining > 0 ? (
									<>
										<input type="number" min="1" max={remaining} value={Math.min(draft.qty, remaining)} onChange={(e) => setDraft(key, { qty: Number(e.target.value) })} />
										<select value={draft.kind} onChange={(e) => setDraft(key, { kind: e.target.value as DecisionKind })}>
											<option value="transfer">Перемещение</option>
											<option value="purchase">Закупка</option>
										</select>
										<select value={draft.kind === 'transfer' ? draft.warehouse : ''} disabled={draft.kind === 'purchase'} onChange={(e) => setDraft(key, { warehouse: e.target.value })}>
											{draft.kind === 'purchase' ? <option value="">не нужен</option> : null}
											{stocks.map(([name, qty]) => <option key={name} value={name}>{name} ({qty})</option>)}
										</select>
										<button className="supply-primary small" type="button" onClick={() => addDecision(key, item, index)}>Добавить</button>
									</>
								) : (
									<>
										<i className="supply-status done">готово</i>
										<span></span><span></span><span></span>
									</>
								)}
							</div>
							{rows.map((row) => (
								<div key={row.id} className="supply-child-row">
									<span>↳ {row.qty} шт · {row.kind === 'transfer' ? `Перемещение · ${row.warehouse ?? ''} → ТТ` : 'Закупка'}</span>
									<i className="supply-status draft">черновик</i>
									<button type="button" onClick={() => removeDecision(key, row.id)}>удалить</button>
								</div>
							))}
						</div>
					);
				})}
			</section>
		</div>
	);
}

export function Supply(): JSX.Element {
	const ctx = getContext();
	const [phase, setPhase] = useState<'init' | 'denied' | 'ready'>('init');
	const [section, setSection] = useState<SectionKey>('orders');
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [loadingOrders, setLoadingOrders] = useState(!ctx.__mock);
	const [previewName, setPreviewName] = useState<string | null>(ctx.__mock ? MOCK_ORDERS[0]?.name ?? null : null);
	const [detailName, setDetailName] = useState<string | null>(null);
	const [decisions, setDecisions] = useState<DecisionMap>({});
	const [drafts, setDrafts] = useState<DraftInput>({});
	const [notice, setNotice] = useState<string | null>(null);

	useEffect(() => {
		if (ctx.__mock) { setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) { setPhase('ready'); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase('denied'); return; }
				setPhase('ready');
				fetchSupplyOrders()
					.then((loaded) => {
						setOrders(loaded);
						setPreviewName(loaded[0]?.name ?? null);
					})
					.catch(() => setOrders([]))
					.finally(() => setLoadingOrders(false));
			})().catch(() => setPhase('denied'));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	const selectedPreview = useMemo(() => orders.find((o) => o.name === previewName) ?? orders[0] ?? null, [orders, previewName]);
	const detailOrder = useMemo(() => orders.find((o) => o.name === detailName) ?? null, [orders, detailName]);
	const grouped = SECTIONS.reduce<Record<string, typeof SECTIONS>>((acc, item) => {
		(acc[item.group] ??= []).push(item);
		return acc;
	}, {});

	const setDraft = (key: string, patch: Partial<DraftInput[string]>): void => {
		setDrafts((current) => ({ ...current, [key]: { qty: 1, kind: 'purchase', warehouse: '', ...(current[key] ?? {}), ...patch } }));
	};
	const addDecision = (key: string, item: SupplyOrderItem, index: number): void => {
		const rows = decisions[key] ?? [];
		const used = rows.reduce((a, d) => a + d.qty, 0);
		const remaining = Math.max(item.qty - used, 0);
		const stocks = stockEntries(item);
		const draft = drafts[key] ?? { qty: remaining || 1, kind: stocks.length ? 'transfer' : 'purchase', warehouse: stocks[0]?.[0] ?? '' };
		const qty = Math.min(Math.max(Number(draft.qty) || 1, 1), remaining);
		if (remaining <= 0) return;
		if (draft.kind === 'transfer' && !draft.warehouse) {
			setNotice('Для перемещения нужно выбрать склад-источник.');
			return;
		}
		const next: Decision = { id: `${Date.now()}-${index}`, productId: item.productId, qty, kind: draft.kind, ...(draft.kind === 'transfer' ? { warehouse: draft.warehouse } : {}) };
		setDecisions((current) => ({ ...current, [key]: [...(current[key] ?? []), next] }));
		setDrafts((current) => ({ ...current, [key]: { ...draft, qty: Math.max(remaining - qty, 1) } }));
		setNotice(null);
	};
	const removeDecision = (key: string, id: string): void => {
		setDecisions((current) => ({ ...current, [key]: (current[key] ?? []).filter((row) => row.id !== id) }));
	};

	if (phase === 'init') return <div className="supply-page supply-state">Загрузка...</div>;
	if (phase === 'denied') return <div className="supply-page supply-state">Раздел «Снаб» в обкатке. Доступ ограничен.</div>;

	return (
		<div className="supply-shell">
			<aside className="supply-rail">
				<div className="supply-brand"><span>С</span><div><b>Снаб</b><small>рабочее место</small></div></div>
				{Object.entries(grouped).map(([group, items]) => (
					<div key={group} className="supply-nav-group">
						<h3>{group}</h3>
						{items.map((item) => <button key={item.key} className={section === item.key ? 'active' : ''} onClick={() => { setSection(item.key); setDetailName(null); }} type="button">{item.title}</button>)}
					</div>
				))}
				<div className="supply-source"><span>Источник данных</span><b>ERPNext / Material Request</b></div>
			</aside>

			{section === 'orders' && detailOrder ? (
				<OrderDetail
					order={detailOrder}
					decisions={decisions}
					drafts={drafts}
					onBack={() => setDetailName(null)}
					setDraft={setDraft}
					addDecision={addDecision}
					removeDecision={removeDecision}
					createDocs={() => setNotice('Формирование документов подключим после утверждения механики. Сейчас это безопасный макет поведения.')}
				/>
			) : (
				<main className="supply-main">
					<header className="supply-top">
						<div>
							<h1>{section === 'orders' ? 'Заявки снабжения' : STUB[section].title}</h1>
							<p>{section === 'orders' ? 'Дефицит из сделок, распределение по источникам, закупка и перемещения' : STUB[section].note}</p>
						</div>
						{section === 'orders' && <button className="supply-primary" type="button" disabled>Создать вручную</button>}
					</header>
					{section === 'orders' ? (
						<>
							<div className="supply-kpis">
								<div><span>Активные заявки</span><b>{orders.filter((o) => !o.closed).length}</b></div>
								<div><span>Позиции</span><b>{orders.reduce((a, o) => a + o.items.length, 0)}</b></div>
								<div><span>Закрытые</span><b>{orders.filter((o) => o.closed).length}</b></div>
							</div>
							<div className="supply-content-grid">
								<OrdersList orders={orders} loading={loadingOrders} selectedName={selectedPreview?.name ?? null} onPreview={(order) => setPreviewName(order.name)} onOpen={(order) => { setPreviewName(order.name); setDetailName(order.name); }} />
								<PreviewPanel order={selectedPreview} />
							</div>
						</>
					) : (
						<section className="supply-card supply-placeholder">
							<h2>{STUB[section].title}</h2>
							<p>{STUB[section].note}</p>
							<span>Раздел подключим после утверждения основного сценария заявок.</span>
						</section>
					)}
				</main>
			)}
			{notice && <div className="supply-toast" onClick={() => setNotice(null)}>{notice}</div>}
		</div>
	);
}
