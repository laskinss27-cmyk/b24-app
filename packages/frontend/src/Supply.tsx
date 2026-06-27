import { useEffect, useState } from 'react';
import { getContext } from './b24-context.js';
import { fetchCurrentUserId, isPortalAdmin, withTimeout, BETA_USER_IDS } from './b24.js';

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

interface Pos { product: string; qty: string; stocks: Array<{ store: string; n: number }> }
interface Order { id: string; deal: string; where: string; due: string; status: string; positions: Pos[] }

// МОК до подключения ядра (заказы = Sales Order по сделкам).
const MOCK_ORDERS: Order[] = [
	{ id: 'ZM-2419', deal: 'D-556', where: 'ТТ Мурино', due: '07.04', status: 'Новый', positions: [
		{ product: 'Блок питания 12В 5А', qty: '2 шт', stocks: [{ store: 'ЦС', n: 12 }, { store: 'Парнас', n: 3 }] },
		{ product: 'Видеорегистратор 8-кан CTV-HD9508', qty: '1 шт', stocks: [{ store: 'ЦС', n: 4 }] },
	] },
	{ id: 'ZM-2418', deal: 'D-553', where: 'ТТ Парнас', due: '06.04', status: 'В разборе', positions: [
		{ product: 'IP-домофон Dahua', qty: '8 шт', stocks: [{ store: 'ЦС', n: 5 }, { store: 'Мурино', n: 3 }] },
		{ product: 'Контроллер СКУД ZKTeco', qty: '4 шт', stocks: [] },
		{ product: 'Кабель UTP cat5e 305м', qty: '2 бухты', stocks: [{ store: 'Девяткино', n: 10 }] },
	] },
	{ id: 'ZM-2416', deal: 'D-551', where: 'ТТ Богатырский', due: '06.04', status: 'В обеспечении', positions: [
		{ product: 'Видеокамера CTV-IPB2028', qty: '4 шт', stocks: [{ store: 'ЦС', n: 20 }, { store: 'Девяткино', n: 6 }] },
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

	useEffect(() => {
		if (ctx.__mock) { setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) { setPhase('ready'); return; }
		bx.init(() => {
			void (async () => {
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!isPortalAdmin() && !BETA_USER_IDS.includes(uid)) { setPhase('denied'); return; }
				setPhase('ready');
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
						{MOCK_ORDERS.map((o) => {
							const open = openId === o.id;
							return (
								<div key={o.id} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
									<div onClick={() => toggle(o.id)} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px', cursor: 'pointer' }}>
										<span style={{ color: C.muted, width: 14 }}>{open ? '▾' : '▸'}</span>
										<b style={{ minWidth: 86 }}>{o.id}</b>
										<span style={{ color: C.muted, fontSize: 13 }}>сделка {o.deal}</span>
										<span style={{ fontSize: 13 }}>→ {o.where}</span>
										<span style={{ color: C.muted, fontSize: 12, marginLeft: 'auto' }}>нужно к {o.due}</span>
										<span style={{ fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999, background: C.surface2, color: C.muted }}>{o.status}</span>
									</div>
									{open && (
										<div style={{ borderTop: `1px solid ${C.line}`, padding: '12px 16px' }}>
											<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
												<thead><tr style={{ color: C.muted, fontSize: 11, textTransform: 'uppercase' }}>
													<th style={{ textAlign: 'left', padding: '6px 8px', width: 28 }}></th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Позиция</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Запрос</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Остатки</th>
													<th style={{ textAlign: 'left', padding: '6px 8px' }}>Источник</th>
												</tr></thead>
												<tbody>
													{o.positions.map((p, i) => (
														<tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
															<td style={{ padding: '8px' }}><input type="checkbox" checked={picked[keyOf(o.id, i)] ?? false} onChange={() => setPicked((m) => ({ ...m, [keyOf(o.id, i)]: !(m[keyOf(o.id, i)] ?? false) }))} /></td>
															<td style={{ padding: '8px' }}><b>{p.product}</b></td>
															<td style={{ padding: '8px' }}>{p.qty}</td>
															<td style={{ padding: '8px' }}>{p.stocks.length ? p.stocks.map((s) => `${s.store}: ${s.n}`).join(' · ') : <span style={{ color: '#ab4343' }}>нет нигде</span>}</td>
															<td style={{ padding: '8px' }}>
																<select style={{ font: 'inherit', fontSize: 12, padding: '6px 8px', border: `1px solid ${C.line}`, borderRadius: 8, background: C.surface }}>
																	<option>выбрать источник…</option>
																	{p.stocks.map((s) => <option key={s.store}>{s.store} ({s.n})</option>)}
																	<option>закупить</option>
																</select>
															</td>
														</tr>
													))}
												</tbody>
											</table>
											<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
												<button onClick={() => alert('Каркас: здесь создадутся перемещения и закупки по выбранным позициям')} style={{ border: 'none', cursor: 'pointer', padding: '9px 14px', borderRadius: 9, fontWeight: 600, background: C.primary, color: '#fff' }}>Обеспечить выбранное</button>
												<button onClick={() => alert('Каркас: массовая закупка отмеченных позиций')} style={{ border: `1px solid ${C.line}`, cursor: 'pointer', padding: '9px 14px', borderRadius: 9, fontWeight: 600, background: C.surface2 }}>Закупить отмеченное</button>
											</div>
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
