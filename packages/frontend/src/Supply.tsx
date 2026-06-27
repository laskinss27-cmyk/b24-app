import { useEffect, useState } from 'react';
import { getContext } from './b24-context.js';
import { fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS, fetchSupplyOrders, type SupplyOrderRow } from './b24.js';

/**
 * «Снаб» — рабочее место снабженца (КАРКАС). Структура по прототипу v2 + правки заказчика
 * из созвона N362: заказы АККОРДЕОНОМ (клик → позиции под ним → чекбоксы → источник →
 * «Обеспечить выбранное»); массовая кнопка «Закупить»; разделы прямых складских операций;
 * раздел «Отчёты». Данные пока МОК — реальные (заказы=Sales Order ядра) подключим следующим шагом.
 */

type SectionKey = 'orders' | 'logistics' | 'purchase' | 'payment' | 'stock' | 'reports';
const SECTIONS: Array<{ key: SectionKey; title: string; group: string }> = [
	{ key: 'orders', title: '📦 Заказы', group: 'Операционная работа' },
	{ key: 'logistics', title: '🚚 Логистика', group: 'Операционная работа' },
	{ key: 'purchase', title: '🛒 Закупки', group: 'Операционная работа' },
	{ key: 'payment', title: '💳 Согласование оплат', group: 'Операционная работа' },
	{ key: 'stock', title: '🏬 Склад', group: 'Склад' },
	{ key: 'reports', title: '📊 Отчёты', group: 'Аналитика' },
];

// Dev-мок в ФОРМЕ реальных данных (заказы = Sales Order ядра). На проде грузим с /api/supply/orders.
const MOCK_ORDERS: SupplyOrderRow[] = [
	{ name: 'SAL-ORD-2026-0001', dealId: '556', dealTitle: 'Монтаж видеонаблюдения', date: '2026-04-04', total: 12800, closed: false, items: [
		{ productId: 104, itemName: 'Блок питания 12В 5А', qty: 2, rate: 650, stocks: { 'ЦС': 12, 'Парнас': 3 } },
		{ productId: 103, itemName: 'Видеорегистратор 8-канальный', qty: 1, rate: 8900, stocks: { 'ЦС': 4 } },
	] },
	{ name: 'SAL-ORD-2026-0002', dealId: '553', dealTitle: 'СКУД офис', date: '2026-04-03', total: 41000, closed: false, items: [
		{ productId: 201, itemName: 'IP-домофон Dahua', qty: 8, rate: 3500, stocks: { 'ЦС': 5, 'Мурино': 3 } },
		{ productId: 202, itemName: 'Контроллер СКУД ZKTeco', qty: 4, rate: 0, stocks: {} },
	] },
	{ name: 'SAL-ORD-2026-0003', dealId: '551', dealTitle: 'Камеры ТТ Богатырский', date: '2026-04-02', total: 9000, closed: true, items: [
		{ productId: 301, itemName: 'Видеокамера CTV-IPB2028', qty: 4, rate: 2250, stocks: { 'ЦС': 20, 'Девяткино': 6 } },
	] },
];

const STUB: Record<SectionKey, { title: string; note: string }> = {
	orders: { title: '', note: '' },
	logistics: { title: '🚚 Логистика', note: 'Перемещения между складами через транзит. Появится после привязки к заказам.' },
	purchase: { title: '🛒 Закупки', note: 'Закупки у поставщиков по дефициту. Появится следующим шагом.' },
	payment: { title: '💳 Согласование оплат', note: 'Этапы согласования счёта (через смарт-процесс Б24).' },
	stock: { title: '🏬 Склад', note: 'Прямые складские документы: перемещение / списание / оприходование / возвраты / движение товара. Можно будет создавать вручную, не только из заказов.' },
	reports: { title: '📊 Отчёты', note: 'Остатки по складам из ядра + в будущем аналитика: оборачиваемость, залежалость позиций.' },
};

const C = { bg: '#f6f4ef', surface: '#fbfaf7', surface2: '#f0ede7', line: '#d9d3c8', text: '#22201b', muted: '#6f6b63', primary: '#0f6c73', primarySoft: '#d9e8e7' };

export function Supply(): JSX.Element {
	const ctx = getContext();
	const [phase, setPhase] = useState<'init' | 'denied' | 'ready'>('init');
	const [section, setSection] = useState<SectionKey>('orders');
	const [openId, setOpenId] = useState<string | null>(null);
	const [picked, setPicked] = useState<Record<string, boolean>>({});
	const [orders, setOrders] = useState<SupplyOrderRow[]>(ctx.__mock ? MOCK_ORDERS : []);
	const [loadingOrders, setLoadingOrders] = useState(!ctx.__mock);

	useEffect(() => {
		if (ctx.__mock) { setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) { setPhase('ready'); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase('denied'); return; }
				setPhase('ready');
				// Реальные заказы из ядра (Sales Order по сделкам). Ядро недоступно → пусто, каркас живёт.
				fetchSupplyOrders().then(setOrders).catch(() => setOrders([])).finally(() => setLoadingOrders(false));
			})().catch(() => setPhase('denied'));
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	if (phase === 'init') return <div style={{ padding: 24, color: C.muted }}>Загрузка…</div>;
	if (phase === 'denied') return <div style={{ padding: 24, color: C.muted }}>🔒 «Снаб» в обкатке — доступен ограниченному кругу.</div>;

	const grouped = SECTIONS.reduce<Record<string, typeof SECTIONS>>((a, s) => { (a[s.group] ??= []).push(s); return a; }, {});
	const toggle = (id: string): void => { setOpenId((cur) => (cur === id ? null : id)); setPicked({}); };
	const keyOf = (oid: string, i: number): string => `${oid}#${i}`;

	return (
		<div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: '100vh', background: C.bg, color: C.text, fontFamily: 'Inter, system-ui, sans-serif' }}>
			<aside style={{ padding: 18, background: C.surface, borderRight: `1px solid ${C.line}` }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
					<div style={{ width: 34, height: 34, borderRadius: 10, background: `linear-gradient(135deg, ${C.primary}, #8bc3c7)` }} />
					<div><b style={{ fontSize: 16 }}>Снаб</b><br /><span style={{ fontSize: 11, color: C.muted }}>рабочее место снабженца</span></div>
				</div>
				{Object.entries(grouped).map(([group, items]) => (
					<div key={group}>
						<h4 style={{ fontSize: 11, color: C.muted, textTransform: 'uppercase', letterSpacing: '.06em', margin: '16px 0 6px' }}>{group}</h4>
						{items.map((s) => (
							<div key={s.key} onClick={() => setSection(s.key)} style={{ padding: '9px 11px', borderRadius: 9, cursor: 'pointer', fontSize: 14, background: section === s.key ? C.primarySoft : 'transparent', color: section === s.key ? C.primary : C.text, fontWeight: section === s.key ? 700 : 400 }}>{s.title}</div>
						))}
					</div>
				))}
				<div style={{ marginTop: 18, padding: 11, borderRadius: 10, background: '#dce8fb', color: '#2d5f98', fontSize: 12, lineHeight: 1.4 }}>Каркас. Данные пока демонстрационные — реальные заказы подтянем из ядра.</div>
			</aside>

			<main style={{ padding: '22px 26px' }}>
				<h1 style={{ margin: '0 0 4px', fontSize: 24 }}>Снабжение и товародвижение</h1>
				<p style={{ margin: '0 0 18px', color: C.muted, fontSize: 13 }}>Каркас рабочего места. Заказы раскрываются по клику.</p>

				{section === 'orders' ? (
					<div style={{ display: 'grid', gap: 10, maxWidth: 1080 }}>
						{loadingOrders && <div style={{ color: C.muted, fontSize: 13 }}>Загрузка заказов из ядра…</div>}
						{!loadingOrders && orders.length === 0 && <div style={{ color: C.muted, fontSize: 13 }}>Заказов в ядре пока нет (заказ появляется, когда в сделку добавляют товар).</div>}
						{orders.map((o) => {
							const open = openId === o.name;
							return (
								<div key={o.name} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden', opacity: o.closed ? 0.55 : 1 }}>
									<div onClick={() => toggle(o.name)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }}>
										<span style={{ color: C.muted, width: 14 }}>{open ? '▾' : '▸'}</span>
										<b style={{ minWidth: 150 }}>{o.dealTitle || `Сделка ${o.dealId}`}</b>
										<span style={{ color: C.muted, fontSize: 13 }}>сделка #{o.dealId}</span>
										<span style={{ fontSize: 13, color: C.muted }}>{o.items.length} поз.</span>
										<span style={{ color: C.muted, fontSize: 12, marginLeft: 'auto' }}>{o.date}</span>
										<span style={{ fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999, background: o.closed ? C.surface2 : '#fff0dc', color: o.closed ? C.muted : '#b26a17' }}>{o.closed ? 'обеспечено' : 'активный'}</span>
									</div>
									{open && (
										<div style={{ borderTop: `1px solid ${C.line}`, padding: '12px 16px' }}>
											<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
												<thead><tr style={{ color: C.muted, fontSize: 11, textTransform: 'uppercase' }}>
													<th style={{ textAlign: 'left', padding: '6px 8px', width: 28 }}></th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Позиция</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Запрос</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Остатки по складам</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Источник</th>
												</tr></thead>
												<tbody>
													{o.items.map((p, i) => {
														const stockEntries = Object.entries(p.stocks).filter(([, n]) => n > 0);
														return (
															<tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
																<td style={{ padding: '8px' }}><input type="checkbox" disabled={o.closed} checked={picked[keyOf(o.name, i)] ?? false} onChange={() => setPicked((m) => ({ ...m, [keyOf(o.name, i)]: !(m[keyOf(o.name, i)] ?? false) }))} /></td>
																<td style={{ padding: '8px' }}><b>{p.itemName || `#${p.productId}`}</b></td>
																<td style={{ padding: '8px' }}>{p.qty} шт</td>
																<td style={{ padding: '8px' }}>{stockEntries.length ? stockEntries.map(([s, n]) => `${s}: ${n}`).join(' · ') : <span style={{ color: '#ab4343' }}>нет нигде</span>}</td>
																<td style={{ padding: '8px' }}>
																	<select disabled={o.closed} style={{ font: 'inherit', fontSize: 12, padding: '6px 8px', border: `1px solid ${C.line}`, borderRadius: 8, background: C.surface }}>
																		<option>выбрать источник…</option>
																		{stockEntries.map(([s, n]) => <option key={s}>{s} ({n})</option>)}
																		<option>закупить</option>
																	</select>
																</td>
															</tr>
														);
													})}
												</tbody>
											</table>
											{!o.closed && (
												<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
													<button onClick={() => alert('Каркас: здесь создадутся перемещения и закупки по выбранным позициям')} style={{ border: 'none', cursor: 'pointer', padding: '9px 14px', borderRadius: 9, fontWeight: 600, background: C.primary, color: '#fff' }}>Обеспечить выбранное</button>
													<button onClick={() => alert('Каркас: массовая закупка отмеченных позиций')} style={{ border: `1px solid ${C.line}`, cursor: 'pointer', padding: '9px 14px', borderRadius: 9, fontWeight: 600, background: C.surface2 }}>Закупить отмеченное</button>
												</div>
											)}
										</div>
									)}
								</div>
							);
						})}
					</div>
				) : (
					<div style={{ maxWidth: 760, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, padding: 20 }}>
						<h2 style={{ margin: '0 0 8px', fontSize: 18 }}>{STUB[section].title}</h2>
						<p style={{ margin: 0, color: C.muted, fontSize: 14, lineHeight: 1.5 }}>{STUB[section].note}</p>
						<p style={{ marginTop: 14, fontSize: 12, color: C.muted }}>🚧 Раздел-заглушка каркаса — наполним по ходу.</p>
					</div>
				)}
			</main>
		</div>
	);
}
