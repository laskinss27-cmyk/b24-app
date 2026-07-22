import { useEffect, useMemo, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import { REPAIR_LOGO } from './repair-logo.js';
import {
	withTimeout,
	fetchCurrentUser,
	fetchRepairs,
	createRepair,
	updateRepair,
	updateRepairInternalComment,
	updateRepairStatus,
	setRepairPayType,
	requestRepairPriceApproval,
	setRepairIssueStore,
	deleteRepair,
	getRepairFileUrl,
	searchRepairContacts,
	findRepairContactByPhone,
	createPresaleRepair,
	fetchRepairStoreStock,
	uploadRepairFile,
	fetchStores,
	openDeal,
	openTask,
	type NewRepairInput,
	type StoreInfo,
	type Repair,
	type RepairKind,
	type RepairStatus,
	type RepairContact,
	type RepairPhoto,
	type RepairFile,
} from './b24.js';

/**
 * Модуль «Ремонты» (RMA) — приём оборудования и сдача поставщику-производителю.
 * Всё наше: страница, список, форма, статусы, печатный бланк. Данные в нашем
 * store (ctv_repairs). От Б24 берём клиента (поиск контакта) и Диск (фото).
 * Вход: пункт левого меню (view='repairs'). Канарейка — как у Базы/Реализаций.
 */

const STATUS_LABEL: Record<RepairStatus, string> = {
	received_tt: 'Принято на ТТ',
	received_office: 'Принято в офисе',
	sent: 'Отправлено в ремонт',
	sent_to_tt: 'Отправлено на ТТ',
	ready_tt: 'Готово к выдаче',
	issued: 'Выдано',
	// предпродажный
	pre_office: 'Принято в офисе',
	pre_sent: 'Отправлено в ремонт',
	pre_back_office: 'Принято с ремонта в офис',
	pre_to_point: 'Отправлено на точку',
	pre_at_tt: 'Принято на ТТ',
};
const STATUS_FLOW: RepairStatus[] = ['received_tt', 'received_office', 'sent', 'sent_to_tt', 'ready_tt', 'issued'];
const PRESALE_FLOW: RepairStatus[] = ['pre_office', 'pre_sent', 'pre_back_office', 'pre_to_point', 'pre_at_tt'];
/** Цепочка статусов по потоку ремонта. */
const flowFor = (kind: RepairKind | undefined): RepairStatus[] => kind === 'presale' ? PRESALE_FLOW : STATUS_FLOW;

/** Со статуса «принято в офисе» КЛИЕНТСКАЯ карточка заморожена — правит только снабжение+. Предпродажный не замораживаем. */
const LOCK_FROM_IDX = STATUS_FLOW.indexOf('received_office');
function isLockedStatus(s: RepairStatus): boolean { const i = STATUS_FLOW.indexOf(s); return i >= 0 && i >= LOCK_FROM_IDX; }

/** Реквизит исполнителя для печатного акта (один на все). */
const ACT_REQUISITE = 'ИП Поляков Д. Ю.';
/** Назначение экземпляров акта (клиент · на точке · для сервиса). */
const COPY_LABELS = ['экземпляр клиента', 'экземпляр точки', 'для сервисного центра'];

const MOCK: Repair[] = [
	{
		id: 1042, repairNo: 102, name: 'Видеодомофон CTV-M5702 · Иванов', status: 'received_tt',
		client: { contactId: 16001, name: 'Иванов Пётр Сергеевич', phone: '+7 921 100-20-30' },
		device: 'Видеодомофон', model: 'CTV-M5702', serial: 'M5702-AB-7781', point: 'Дунайский 64', appearance: 'Царапина на рамке снизу. Комплект: монитор',
		defect: 'Не включается экран, питание есть', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: '', internalComment: 'Клиент просил позвонить после диагностики.', photos: [], files: [],
		createdAt: new Date().toISOString(), createdById: '1858', createdByName: 'Сергей Ласкин',
		history: [{ at: new Date().toISOString(), status: 'received_tt', byId: '1858' }],
	},
	{
		id: 1039, repairNo: 101, name: 'Контроллер Shelly Pro 4PM · ООО Дом', status: 'sent',
		client: { contactId: null, name: 'ООО «Умный дом»', phone: '+7 812 700-10-10' },
		device: 'Контроллер', model: 'Shelly Pro 4PM', serial: 'SH-4PM-55012', point: 'Измайловский 18Д', appearance: 'Без видимых повреждений. Комплект: контроллер, б/п',
		defect: 'Не отвечает по сети после грозы', payType: 'paid', cost: 3500, ourPrice: 5200, dealId: null, comment: 'СЦ: вне гарантии — замена платы питания', internalComment: 'Согласовать цену с клиентом до отправки.', photos: [], files: [],
		createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), createdById: '1858', createdByName: 'Сергей Ласкин',
		history: [
			{ at: new Date(Date.now() - 3 * 864e5).toISOString(), status: 'received_tt', byId: '986', byName: 'Игорь Бекасов' },
			{ at: new Date(Date.now() - 2 * 864e5).toISOString(), status: 'received_office', byId: '78', byName: 'Даниил Андропов' },
			{ at: new Date(Date.now() - 2 * 864e5 + 36e5).toISOString(), status: 'sent', byId: '78', byName: 'Даниил Андропов', note: 'вид: платный, цена: 3500₽' },
		],
	},
	{
		id: 1031, repairNo: 100, name: 'IP-камера Dahua · Петров', status: 'issued',
		client: { contactId: 16044, name: 'Петров Иван', phone: '+7 905 222-33-44' },
		device: 'IP-камера', model: 'Dahua IPC-HFW2', serial: 'DH-2230-91кп', point: 'Дунайский 64', appearance: 'Потёртости корпуса. Комплект: камера, кронштейн',
		defect: 'Засветы по ИК-подсветке', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: 'СЦ: неисправность не подтвердилась, прошивка обновлена', internalComment: '', photos: [], files: [],
		createdAt: new Date(Date.now() - 20 * 864e5).toISOString(), createdById: '986', createdByName: 'Игорь Бекасов',
		history: [],
	},
];

function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }
function ruDate(s: string): string {
	if (!s) return '';
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? s : `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function ruDateTime(s: string): string {
	if (!s) return '';
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? s : `${ruDate(s)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Отображаемый номер: наш короткий (со 100), для старых карточек без него — технический ID. */
function repairNo(r: Repair): number { return r.repairNo && r.repairNo > 0 ? r.repairNo : r.id; }
function money(n: number | null): string { return n == null ? '' : `${n.toLocaleString('ru-RU')} ₽`; }
function repairPointLabel(r: Repair): string {
	if (r.point) return r.point;
	if (r.kind === 'presale') return r.sourceStore ?? r.issueStore ?? '';
	return '';
}
function repairCompleteness(r: Repair): string {
	const value = String(r.appearance ?? '').trim();
	const match = value.match(/(?:комплект(?:ация)?|в комплекте)\s*[:—-]?\s*(.+)$/i);
	return match?.[1]?.trim() || value || '—';
}
function repairFileHref(file: RepairFile | RepairPhoto): string {
	return file.id > 0 ? `/api/repairs/file/${file.id}` : file.url;
}

async function openRepairFile(file: RepairFile): Promise<void> {
	const win = window.open('', '_blank');
	try {
		const url = file.id > 0 ? await getRepairFileUrl(file.id) : file.url;
		if (!url) throw new Error('ссылка на файл пустая');
		if (win) win.location.href = url;
		else window.open(url, '_blank', 'noopener,noreferrer');
	} catch (error) {
		if (win) win.close();
		window.alert(String(error instanceof Error ? error.message : error));
	}
}

/** Фото → ужатый data-URL (хранится в нашем store; Диск Б24 недоступен — нет scope). */
async function fileToPhoto(file: File, maxPx = 1280, quality = 0.7): Promise<RepairPhoto> {
	const url = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error('не прочитать файл'));
		reader.onload = () => {
			const img = new Image();
			img.onerror = () => reject(new Error('не картинка'));
			img.onload = () => {
				const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
				const w = Math.max(1, Math.round(img.width * scale));
				const h = Math.max(1, Math.round(img.height * scale));
				const canvas = document.createElement('canvas');
				canvas.width = w; canvas.height = h;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('canvas')); return; }
				ctx.drawImage(img, 0, 0, w, h);
				resolve(canvas.toDataURL('image/jpeg', quality));
			};
			img.src = String(reader.result ?? '');
		};
		reader.readAsDataURL(file);
	});
	return { id: 0, name: file.name, url };
}

type Phase = { k: 'init' } | { k: 'ready' };
type DispatchContact = { name: string; phone: string };
type Screen =
	| { k: 'list' }
	| { k: 'form'; initial?: Repair }
	| { k: 'presale' }
	| { k: 'card'; repair: Repair }
	| { k: 'print'; repair: Repair }
	| { k: 'issue-print'; repair: Repair }
	| { k: 'dispatch-print'; repairs: Repair[] };

export function Repairs(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [screen, setScreen] = useState<Screen>({ k: 'list' });
	const [repairs, setRepairs] = useState<Repair[]>([]);
	const [canEditPrice, setCanEditPrice] = useState(false);
	const [dispatchContact, setDispatchContact] = useState<DispatchContact>({ name: '', phone: '' });
	const [err, setErr] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [deepLinkHandled, setDeepLinkHandled] = useState(false);
	const queryRepairId = Number(new URLSearchParams(window.location.search).get('repairId') ?? 0);

	async function load(): Promise<void> {
		setErr(null);
		setLoading(true);
		try {
			if (ctx.__mock) {
				setRepairs(MOCK);
				setCanEditPrice(true);
				setDispatchContact({ name: 'Андропов Даниил', phone: '+7 921 000-00-00' });
				return;
			}
			const res = await withTimeout(fetchRepairs(), 30000, 'repairs/list');
			setRepairs(res.repairs);
			setCanEditPrice(res.canEditPrice);
			void withTimeout(fetchCurrentUser(), 15000, 'user.current')
				.then((user) => setDispatchContact({ name: user.name, phone: user.phone }))
				.catch(() => undefined);
		} catch (e: unknown) {
			setErr(String(e instanceof Error ? e.message : e));
		} finally {
			setLoading(false);
		}
	}

	async function openDispatchPrint(selected: Repair[]): Promise<void> {
		let contact = dispatchContact;
		if (!ctx.__mock && !contact.name) {
			try {
				const user = await withTimeout(fetchCurrentUser(), 15000, 'user.current');
				contact = { name: user.name, phone: user.phone };
				setDispatchContact(contact);
			} catch { /* Печать остаётся доступной, даже если профиль Б24 временно не ответил. */ }
		}
		setScreen({ k: 'dispatch-print', repairs: selected });
	}

	useEffect(() => {
		if (ctx.__mock) { setPhase({ k: 'ready' }); void load(); return; }
		const bx = window.BX24;
		if (!bx) { setErr('BX24 SDK не загружен.'); setPhase({ k: 'ready' }); return; }
		// Ремонты раскатаны на ВСЕХ (GA) — бета-гейта нет, ждём только готовности BX24 SDK.
		bx.init(() => { setPhase({ k: 'ready' }); void load(); });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctx]);

	useEffect(() => {
		const repairId = Number(ctx.repairId ?? queryRepairId);
		if (deepLinkHandled || !Number.isInteger(repairId) || repairId <= 0 || repairs.length === 0) return;
		const repair = repairs.find((row) => row.id === repairId || repairNo(row) === repairId);
		if (!repair) return;
		setDeepLinkHandled(true);
		setScreen({ k: 'card', repair });
	}, [ctx.repairId, deepLinkHandled, queryRepairId, repairs]);

	if (phase.k === 'init') return <Shell><p className="base-load">Загрузка…</p></Shell>;

	if (screen.k === 'print') return <RepairBlank repair={screen.repair} onBack={() => setScreen({ k: 'card', repair: screen.repair })} />;
	if (screen.k === 'issue-print') return <RepairIssueBlank repair={screen.repair} onBack={() => setScreen({ k: 'card', repair: screen.repair })} />;
	if (screen.k === 'dispatch-print') return <RepairDispatchBlank repairs={screen.repairs} contact={dispatchContact} onBack={() => setScreen({ k: 'list' })} />;

	if (screen.k === 'form') {
		const initial = screen.initial;
		const mk = (input: NewRepairInput): Repair => ({
			id: initial?.id ?? Math.floor(1000 + Math.random() * 9000),
			repairNo: initial?.repairNo ?? 100,
			name: [input.device, input.model, input.client.name].filter(Boolean).join(' · ') || 'Ремонт',
			status: initial?.status ?? 'received_tt',
			...input,
			dealId: initial?.dealId ?? null,
			createdAt: initial?.createdAt ?? new Date().toISOString(),
			createdById: initial?.createdById ?? 'dev',
			createdByName: initial?.createdByName ?? 'dev (mock)',
			history: initial?.history ?? [{ at: new Date().toISOString(), status: 'received_tt', byId: 'dev' }],
		});
		return (
			<Shell>
				<RepairForm
					mock={Boolean(ctx.__mock)}
					canEditPrice={canEditPrice}
					initial={initial}
					onCancel={() => setScreen(initial ? { k: 'card', repair: initial } : { k: 'list' })}
					submit={async (input) => {
						if (ctx.__mock) return mk(input);
						return initial ? updateRepair(initial.id, input) : createRepair(input);
					}}
					onDone={async (r) => { await load(); setScreen({ k: 'card', repair: r }); }}
				/>
			</Shell>
		);
	}

	if (screen.k === 'presale') {
		return (
			<Shell>
				<PresaleForm
					mock={Boolean(ctx.__mock)}
					onCancel={() => setScreen({ k: 'list' })}
					onDone={async (r) => { await load(); setScreen({ k: 'card', repair: r }); }}
				/>
			</Shell>
		);
	}

	if (screen.k === 'card') {
		return (
			<Shell>
				<RepairCard
					repair={screen.repair}
					mock={Boolean(ctx.__mock)}
					canEditPrice={canEditPrice}
					onBack={() => setScreen({ k: 'list' })}
					onEdit={() => setScreen({ k: 'form', initial: screen.repair })}
					onSaveInternalComment={async (internalComment) => {
						const next = ctx.__mock
							? { ...screen.repair, internalComment }
							: await updateRepairInternalComment(screen.repair.id, internalComment);
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((row) => row.id === next.id ? next : row));
					}}
					onPrint={() => setScreen({ k: 'print', repair: screen.repair })}
					onIssuePrint={() => setScreen({ k: 'issue-print', repair: screen.repair })}
					onStatus={async (st) => {
						const historyRow = { at: new Date().toISOString(), status: st, byId: 'current' };
						const next = { ...screen.repair, status: st, history: [...screen.repair.history, historyRow] };
						if (!ctx.__mock) await updateRepairStatus(screen.repair.id, st);
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
					}}
					onSetPay={async (payType, cost, ourPrice) => {
						const res = ctx.__mock
							? { payType, cost, ourPrice, dealId: screen.repair.dealId, dealCreated: false, dealNoContact: false }
							: await setRepairPayType(screen.repair.id, payType, cost, ourPrice);
						const next = { ...screen.repair, payType: res.payType, cost: res.cost, ourPrice: res.ourPrice, dealId: res.dealId ?? screen.repair.dealId };
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
						return { dealCreated: res.dealCreated, dealNoContact: res.dealNoContact };
					}}
					onRequestPriceApproval={async (cost, ourPrice) => {
						const res = ctx.__mock
							? { repair: { ...screen.repair, payType: 'paid' as const, cost, ourPrice }, dealCreated: false, dealNoContact: false }
							: await requestRepairPriceApproval(screen.repair.id, cost, ourPrice);
						setScreen({ k: 'card', repair: res.repair });
						setRepairs((prev) => prev.map((x) => (x.id === res.repair.id ? res.repair : x)));
						return { dealCreated: res.dealCreated, dealNoContact: res.dealNoContact };
					}}
					onSetIssueStore={async (store) => {
						const issueStore = ctx.__mock ? (store || null) : await setRepairIssueStore(screen.repair.id, store);
						const next = { ...screen.repair, issueStore };
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
					}}
					onDelete={async () => {
						const id = screen.repair.id;
						if (!ctx.__mock) await deleteRepair(id);
						setRepairs((prev) => prev.filter((x) => x.id !== id));
						setScreen({ k: 'list' });
					}}
				/>
			</Shell>
		);
	}

	return (
		<Shell>
			<RepairList
				repairs={repairs}
				loading={loading}
				err={err}
				onAdd={() => setScreen({ k: 'form' })}
				onPresale={() => setScreen({ k: 'presale' })}
				onOpen={(r) => setScreen({ k: 'card', repair: r })}
				onPrintSelected={(selected) => { void openDispatchPrint(selected); }}
				onReload={() => void load()}
			/>
		</Shell>
	);
}

function RepairList({ repairs, loading, err, onAdd, onPresale, onOpen, onPrintSelected, onReload }: {
	repairs: Repair[]; loading: boolean; err: string | null;
	onAdd: () => void; onPresale: () => void; onOpen: (r: Repair) => void; onPrintSelected: (repairs: Repair[]) => void; onReload: () => void;
}): JSX.Element {
	const [q, setQ] = useState('');
	const [st, setSt] = useState<RepairStatus | 'all'>('all');
	const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
	const view = useMemo(() => {
		const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
		return repairs.filter((r) => {
			if (st !== 'all' && r.status !== st) return false;
			if (!words.length) return true;
			const status = STATUS_LABEL[r.status] ?? r.status;
			const history = (r.history ?? []).map((h) => `${h.byName ?? h.byId ?? ''} ${h.note ?? ''} ${STATUS_LABEL[h.status] ?? h.status}`).join(' ');
			const files = (r.files ?? []).map((file) => file.name).join(' ');
			const hay = `${repairNo(r)} ${r.id} ${r.client.name} ${r.client.phone} ${repairPointLabel(r)} ${r.device} ${r.model} ${r.serial} ${r.defect} ${r.comment} ${r.internalComment ?? ''} ${r.createdByName} ${r.createdById} ${r.dealId ?? ''} ${r.taskId ?? ''} ${status} ${files} ${history}`.toLowerCase();
			return words.every((w) => hay.includes(w));
		});
	}, [repairs, q, st]);
	const active = view.filter((r) => r.status !== 'issued').length;
	const selectedRepairs = repairs.filter((repair) => selectedIds.has(repair.id));
	const allVisibleSelected = view.length > 0 && view.every((repair) => selectedIds.has(repair.id));

	useEffect(() => {
		const existing = new Set(repairs.map((repair) => repair.id));
		setSelectedIds((current) => new Set([...current].filter((id) => existing.has(id))));
	}, [repairs]);

	const toggleRepair = (id: number): void => {
		setSelectedIds((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const toggleVisible = (): void => {
		setSelectedIds((current) => {
			const next = new Set(current);
			for (const repair of view) {
				if (allVisibleSelected) next.delete(repair.id);
				else next.add(repair.id);
			}
			return next;
		});
	};

	return (
		<>
			<div className="base-toolbar">
				<button className="btn-primary" onClick={onAdd}>➕ Принять в ремонт</button>
				<button className="btn-secondary" onClick={onPresale}>🛠 Предпродажный ремонт</button>
				<button className="btn-secondary" disabled={selectedRepairs.length === 0} onClick={() => onPrintSelected(selectedRepairs)}>Сопроводительное письмо{selectedRepairs.length ? ` (${selectedRepairs.length})` : ''}</button>
				<label className="tb-field">Статус
					<select value={st} onChange={(e) => setSt(e.target.value as RepairStatus | 'all')}>
						<option value="all">Все статусы</option>
						{STATUS_FLOW.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
					</select>
				</label>
				<label className="tb-field tb-search">Поиск (№ · клиент · серийник · модель · комментарий)
					<input type="search" value={q} placeholder="1042, иванов, M5702…" autoComplete="off" onChange={(e) => setQ(e.target.value)} />
				</label>
				<div className="tb-spacer" />
				<button className="btn-secondary" onClick={onReload} disabled={loading} title="Обновить список">{loading ? 'Гружу…' : '↻ Обновить'}</button>
			</div>

			{err && <p className="error">⛔ {err}</p>}
			{loading && repairs.length === 0 && <p className="muted">Загружаю ремонты…</p>}

			{!loading && view.length === 0 ? (
				<p className="stub-calm">{(q || st !== 'all') ? 'Ничего не найдено.' : 'Ремонтов пока нет. Нажми «Принять в ремонт».'}</p>
			) : (
				<div className="table-wrap">
					<table className="products-table report-table">
						<thead>
							<tr><th className="repair-select-cell"><input type="checkbox" checked={allVisibleSelected} aria-label="Выбрать все показанные ремонты" onChange={toggleVisible} /></th><th>№</th><th>Клиент</th><th>ТТ приема</th><th>Оборудование</th><th>Серийный №</th><th>Вид</th><th>Наша цена</th><th>Неисправность</th><th>Комментарий</th><th>Статус</th><th>Принят</th></tr>
						</thead>
						<tbody>
							{view.map((r) => (
								<tr key={r.id} className={`repair-row${r.status === 'issued' ? ' done' : ''}${selectedIds.has(r.id) ? ' selected' : ''}`} onClick={() => onOpen(r)}>
									<td className="repair-select-cell" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={selectedIds.has(r.id)} aria-label={`Выбрать ремонт № ${repairNo(r)}`} onChange={() => toggleRepair(r.id)} /></td>
									<td><b>#{repairNo(r)}</b></td>
									<td>{r.kind === 'presale' ? <span className="pay-badge presale">🛠 предпродажа</span> : (<>{r.client.name || <span className="muted">—</span>}{r.client.phone && <div className="muted small">{r.client.phone}</div>}</>)}</td>
									<td className="nowrap">{repairPointLabel(r) || <span className="muted">—</span>}</td>
									<td>{[r.device, r.model].filter(Boolean).join(' ') || <span className="muted">—</span>}</td>
									<td className="nowrap">{r.serial || <span className="muted">—</span>}</td>
									<td>{r.kind === 'presale' ? <span className="muted">—</span> : <span className={`pay-badge ${r.payType}`}>{r.payType === 'paid' ? 'платный' : 'гарантия'}</span>}</td>
									<td className="nowrap">{r.payType === 'paid' && r.ourPrice != null ? <b>{money(r.ourPrice)}</b> : <span className="muted">—</span>}</td>
									<td className="repair-comment">{r.defect ? <span title={r.defect}>{r.defect}</span> : <span className="muted">—</span>}</td>
									<td className="repair-comment">{r.internalComment ? <span title={r.internalComment}>{r.internalComment}</span> : <span className="muted">—</span>}</td>
									<td>{r.status === 'issued' ? <span className="status-done">завершён</span> : <span className={`repair-st st-${r.status}`}>{STATUS_LABEL[r.status]}</span>}</td>
									<td className="muted nowrap">{ruDate(r.createdAt)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="base-foot">
				<span>Всего: {view.length}</span>
				<span>В работе: {active}</span>
			</div>
		</>
	);
}

function RepairForm({ mock, canEditPrice, initial, onCancel, submit, onDone }: {
	mock: boolean;
	canEditPrice: boolean;
	initial?: Repair | undefined;
	onCancel: () => void;
	submit: (input: NewRepairInput) => Promise<Repair>;
	onDone: (r: Repair) => Promise<void>;
}): JSX.Element {
	const isEdit = Boolean(initial);
	const [clientName, setClientName] = useState(initial?.client.name ?? '');
	const [clientPhone, setClientPhone] = useState(initial?.client.phone ?? '');
	const [contactId, setContactId] = useState<number | null>(initial?.client.contactId ?? null);
	const [results, setResults] = useState<RepairContact[]>([]);
	const [phoneMatch, setPhoneMatch] = useState<RepairContact | null>(null);
	const [device, setDevice] = useState(initial?.device ?? '');
	const [model, setModel] = useState(initial?.model ?? '');
	const [serial, setSerial] = useState(initial?.serial ?? '');
	const [point, setPoint] = useState(initial?.point ?? '');
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [appearance, setAppearance] = useState(initial?.appearance ?? '');
	const [defect, setDefect] = useState(initial?.defect ?? '');
	const [internalComment, setInternalComment] = useState(initial?.internalComment ?? '');
	const [comment, setComment] = useState(initial?.comment ?? '');
	const [payType, setPayType] = useState<'warranty' | 'paid'>(initial?.payType ?? 'warranty');
	const [cost, setCost] = useState<string>(initial?.cost != null ? String(initial.cost) : '');
	const [ourPrice, setOurPrice] = useState<string>(initial?.ourPrice != null ? String(initial.ourPrice) : '');
	const [photos, setPhotos] = useState<RepairPhoto[]>(initial?.photos ?? []);
	const [files, setFiles] = useState<RepairFile[]>(initial?.files ?? []);
	const [uploading, setUploading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [formErr, setFormErr] = useState<string | null>(null);
	const [pointMissing, setPointMissing] = useState(false);

	useEffect(() => { fetchStores().then((s) => setStores(s.filter((x) => x.active))).catch(() => setStores([])); }, []);

	async function searchContacts(v: string): Promise<void> {
		setClientName(v);
		setContactId(null);
		if (mock || v.trim().length < 2) { setResults([]); return; }
		try { setResults(await searchRepairContacts(v)); } catch { setResults([]); }
	}
	function pickContact(c: RepairContact): void {
		setClientName(c.name); setClientPhone(c.phone); setContactId(c.id); setResults([]); setPhoneMatch(null);
	}
	function changePoint(value: string): void {
		setPoint(value);
		if (value.trim()) {
			setPointMissing(false);
			if (formErr === 'Выбери склад приёмки — без него ремонт сохранить нельзя.') setFormErr(null);
		}
	}
	/** Проактивный подбор по номеру: при уходе из поля телефона ищем занявший его контакт и показываем плашку. */
	async function checkPhone(): Promise<void> {
		if (mock || contactId || clientPhone.trim().length < 4) { setPhoneMatch(null); return; }
		try { setPhoneMatch(await findRepairContactByPhone(clientPhone.trim())); } catch { /* молча — подстрахует сабмит */ }
	}

	/** Одна кнопка на всё: изображения → превью (data-URL), документы Word/Excel/PDF → Диск Б24 (ссылка). */
	async function onAttach(fl: FileList | null): Promise<void> {
		if (!fl || !fl.length) return;
		setUploading(true); setFormErr(null);
		try {
			for (const f of Array.from(fl)) {
				if (f.type.startsWith('image/')) {
					try { const photo = await fileToPhoto(f); setPhotos((p) => [...p, photo]); }
					catch { setFormErr('Не удалось обработать фото (ремонт можно сохранить без него).'); }
				} else if (mock) {
					setFiles((p) => [...p, { id: 0, name: f.name, url: '#', type: f.type }]);
				} else {
					try {
						const up = await uploadRepairFile(f);
						if (up) setFiles((p) => [...p, up]);
						else setFormErr('Не удалось загрузить документ на Диск (ремонт можно сохранить без него).');
					} catch { setFormErr('Не удалось загрузить документ на Диск (ремонт можно сохранить без него).'); }
				}
			}
		} finally { setUploading(false); }
	}

	async function onSubmit(): Promise<void> {
		if (!clientName.trim()) { setFormErr('Клиент обязателен — выбери из базы или впиши ФИО (новый создастся в Б24).'); return; }
		if (!contactId && !clientPhone.trim()) { setFormErr('Укажи телефон клиента — по нему найдём существующего или заведём нового в Б24.'); return; }
		if (!point.trim()) {
			setPointMissing(true);
			setFormErr('Выбери склад приёмки — без него ремонт сохранить нельзя.');
			return;
		}
		// Контроль дублей: номер занят существующим контактом — спрашиваем приёмщика ДО сохранения,
		// чтобы ремонт не повис молча на чужом контакте (Б24 всё равно не создаст дубль по номеру).
		if (!contactId && !mock && clientPhone.trim()) {
			const found = await findRepairContactByPhone(clientPhone.trim()).catch(() => null);
			if (found) { setPhoneMatch(found); setFormErr(null); return; }
		}
		setSaving(true); setFormErr(null);
		try {
			const input: NewRepairInput = {
				client: { contactId, name: clientName.trim(), phone: clientPhone.trim() },
				device: device.trim(), model: model.trim(), serial: serial.trim(), point: point.trim(),
				appearance: appearance.trim(), defect: defect.trim(), internalComment: internalComment.trim(), comment: comment.trim(), payType,
				cost: payType === 'paid' && cost.trim() !== '' && Number.isFinite(Number(cost)) ? Number(cost) : null,
				ourPrice: payType === 'paid' && ourPrice.trim() !== '' && Number.isFinite(Number(ourPrice)) ? Number(ourPrice) : null,
				photos, files,
			};
			const r = await submit(input);
			await onDone(r);
		} catch (e: unknown) {
			setFormErr(String(e instanceof Error ? e.message : e));
		} finally { setSaving(false); }
	}

	return (
		<div className="repair-form">
			<div className="base-backbar"><button className="btn-secondary" onClick={onCancel}>{isEdit ? '← К ремонту' : '← К списку'}</button></div>
			<h2>{isEdit ? `Редактировать ремонт #${initial!.id}` : 'Принять в ремонт'}</h2>

			<div className="rf-grid">
				<label className="rf-field rf-wide">Клиент (ФИО / организация)
					<input type="text" value={clientName} placeholder="начните вводить — поиск по контактам" onChange={(e) => void searchContacts(e.target.value)} />
					{results.length > 0 && (
						<div className="rf-suggest">
							{results.map((c) => (
								<button key={c.id} type="button" className="rf-suggest-item" onClick={() => pickContact(c)}>
									{c.name}{c.phone && <span className="muted small"> · {c.phone}</span>}
								</button>
							))}
						</div>
					)}
					{contactId
						? <span className="muted small">✓ контакт Б24 #{contactId}</span>
						: clientName.trim() ? <span className="muted small">＋ новый клиент — создастся в Б24 с телефоном</span> : null}
				</label>
				<label className="rf-field">Телефон
					<input type="text" value={clientPhone} placeholder="+7 …" onChange={(e) => { setClientPhone(e.target.value); setPhoneMatch(null); }} onBlur={() => void checkPhone()} />
				</label>
				{phoneMatch && (
					<div className="rf-phone-match" style={{ gridColumn: '1 / -1' }}>
						📞 По номеру <b>{phoneMatch.phone || clientPhone}</b> уже есть контакт: <b>{phoneMatch.name}</b>. Это он?
						<div className="rf-phone-match-actions">
							<button type="button" className="btn-secondary" onClick={() => pickContact(phoneMatch)}>Да, это клиент</button>
							<button type="button" className="btn-secondary" onClick={() => setPhoneMatch(null)}>Другой — исправлю номер</button>
						</div>
					</div>
				)}

				<label className="rf-field">Оборудование
					<input type="text" value={device} placeholder="видеодомофон, контроллер…" onChange={(e) => setDevice(e.target.value)} />
				</label>
				<label className="rf-field">Модель
					<input type="text" value={model} placeholder="CTV-M5702" onChange={(e) => setModel(e.target.value)} />
				</label>
				<label className="rf-field">Серийный №
					<input type="text" value={serial} placeholder="с корпуса устройства" onChange={(e) => setSerial(e.target.value)} />
				</label>
				<label className={`rf-field${pointMissing ? ' rf-field-error' : ''}`}><span>Склад приёмки <span className="rf-required">обязательно</span></span>
					{stores.length ? (
						<select required aria-invalid={pointMissing} value={point} onChange={(e) => changePoint(e.target.value)}>
							<option value="">— обязательно выбери склад —</option>
							{stores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
						</select>
					) : (
						<input required aria-invalid={pointMissing} type="text" value={point} placeholder="укажи склад приёмки" onChange={(e) => changePoint(e.target.value)} />
					)}
					{pointMissing && <span className="rf-field-error-text">Выбери склад приёмки</span>}
				</label>

				<label className="rf-field rf-wide">Внешний вид и комплектация
					<textarea value={appearance} rows={2} placeholder="царапины, сколы, что в комплекте…" onChange={(e) => setAppearance(e.target.value)} />
				</label>
				<label className="rf-field rf-wide">Описание неисправности
					<textarea value={defect} rows={2} placeholder="со слов клиента" onChange={(e) => setDefect(e.target.value)} />
				</label>
				<label className="rf-field rf-wide">Внутренний комментарий
					<textarea value={internalComment} rows={2} placeholder="для себя: что уточнить, кому позвонить, особенности ремонта…" onChange={(e) => setInternalComment(e.target.value)} />
					<span className="muted small">виден в карточке и общем списке, в печатный акт не попадает</span>
				</label>
				<label className="rf-field rf-wide">Комментарий сервисного центра
					<textarea value={comment} rows={2} disabled={!canEditPrice} placeholder={canEditPrice ? 'диагностика / итог ремонта — заполняется после возврата' : 'заполняет отдел снабжения'} onChange={(e) => setComment(e.target.value)} />
					{!canEditPrice && <span className="muted small">заполняет и правит только снабжение</span>}
				</label>

				<div className="rf-field">Вид ремонта
					<div className="rf-radio">
						<label><input type="radio" name="pay" checked={payType === 'warranty'} onChange={() => setPayType('warranty')} /> Гарантийный</label>
						<label><input type="radio" name="pay" checked={payType === 'paid'} onChange={() => setPayType('paid')} /> Платный</label>
					</div>
				</div>
				{payType === 'paid' && (
					<div className="rf-field rf-wide rf-prices">
						{canEditPrice ? (
							<label className="rf-price-col">Цена ремонта СЦ, ₽
								<input type="number" min="0" step="1" value={cost} placeholder="что берёт сервис-центр" onChange={(e) => setCost(e.target.value)} />
							</label>
						) : (
							<div className="rf-price-col">Цена ремонта СЦ
								<span className="rf-readonly">{cost.trim() !== '' ? `${cost} ₽` : 'укажет руководитель / отдел закупки'}</span>
							</div>
						)}
						{canEditPrice ? (
							<label className="rf-price-col">Наша цена, ₽
								<input type="number" min="0" step="1" value={ourPrice} placeholder="что берём с клиента → сделка" onChange={(e) => setOurPrice(e.target.value)} />
							</label>
						) : (
							<div className="rf-price-col">Наша цена
								<span className="rf-readonly">{ourPrice.trim() !== '' ? `${ourPrice} ₽` : 'укажет руководитель / отдел закупки'}</span>
							</div>
						)}
					</div>
				)}

				<label className="rf-field rf-wide">Файлы — фото и документы (Word, Excel, PDF)
					<input type="file" accept="image/*,.doc,.docx,.xls,.xlsx,.pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf" multiple onChange={(e) => void onAttach(e.target.files)} />
					{uploading && <span className="muted small">загружаю…</span>}
				</label>
			</div>

			{files.length > 0 && (
				<div className="rf-files">
					{files.map((f, i) => (
						<div key={`${f.id}-${i}`} className="rf-file">
							<span className="rf-file-ic">📄</span>
							<span className="rf-file-name">{f.name}</span>
							<button type="button" className="rf-file-x" title="Убрать" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>✕</button>
						</div>
					))}
				</div>
			)}

			{photos.length > 0 && (
				<div className="rf-photos">
					{photos.map((p, i) => (
						<div key={`${p.id}-${i}`} className="rf-photo">
							<img src={p.url} alt={p.name} />
							<button type="button" className="rf-photo-x" title="Убрать" onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}>✕</button>
						</div>
					))}
				</div>
			)}

			{formErr && <p className="error">⛔ {formErr}</p>}

			<div className="rf-actions">
				<button className="btn-primary" onClick={() => void onSubmit()} disabled={saving || uploading}>{saving ? (isEdit ? 'Сохраняю…' : 'Создаю…') : (isEdit ? 'Сохранить' : 'Создать')}</button>
				<button className="btn-secondary" onClick={onCancel} disabled={saving}>Отмена</button>
			</div>
		</div>
	);
}

/** Форма предпродажного ремонта: выбрать склад-источник → аппарат из его остатков → в ремонт.
 *  Без клиента/цен/сделки — двигаем существующий товар (productId) по складам. */
function PresaleForm({ mock, onCancel, onDone }: { mock: boolean; onCancel: () => void; onDone: (r: Repair) => Promise<void> }): JSX.Element {
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [sourceStore, setSourceStore] = useState('');
	const [items, setItems] = useState<Array<{ productId: number; name: string; qty: number }>>([]);
	const [loadingItems, setLoadingItems] = useState(false);
	const [picked, setPicked] = useState<{ productId: number; name: string } | null>(null);
	const [q, setQ] = useState('');
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => { if (!mock) fetchStores().then((s) => setStores(s.filter((x) => x.active))).catch(() => setStores([])); }, [mock]);
	async function loadItems(store: string): Promise<void> {
		setSourceStore(store); setPicked(null); setItems([]); setErr(null);
		if (!store || mock) return;
		setLoadingItems(true);
		try { setItems(await fetchRepairStoreStock(store)); } catch (e: unknown) { setErr(String(e instanceof Error ? e.message : e)); } finally { setLoadingItems(false); }
	}
	const filtered = items.filter((i) => { const t = q.trim().toLowerCase(); return !t || i.name.toLowerCase().includes(t) || String(i.productId).includes(t); });
	async function submit(): Promise<void> {
		if (!sourceStore) { setErr('Выбери склад-источник.'); return; }
		if (!picked) { setErr('Выбери аппарат из остатков склада.'); return; }
		setSaving(true); setErr(null);
		try {
			if (mock) {
				await onDone({ id: Math.floor(1000 + Math.random() * 9000), name: `[предпродажа] ${picked.name}`, kind: 'presale', status: 'pre_office', repairNo: 100, client: { contactId: null, name: '', phone: '' }, device: picked.name, model: '', serial: '', point: '', appearance: '', defect: '', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: '', internalComment: '', photos: [], files: [], createdAt: new Date().toISOString(), createdById: 'dev', createdByName: 'dev (mock)', history: [], productId: picked.productId, sourceStore, repairStore: 'Измайловский 18Д', issueStore: null } as Repair);
				return;
			}
			const r = await createPresaleRepair(sourceStore, picked.productId, picked.name);
			await onDone(r);
		} catch (e: unknown) { setErr(String(e instanceof Error ? e.message : e)); } finally { setSaving(false); }
	}
	return (
		<div className="repair-form">
			<div className="base-backbar"><button className="btn-secondary" onClick={onCancel}>← К списку</button></div>
			<h2>🛠 Предпродажный ремонт</h2>
			<p className="muted small">Наш товар со склада уходит в ремонт. Выбери склад-источник и аппарат — дальше ведём по статусам. Без клиента, цен и сделки.</p>
			<div className="rf-grid">
				<label className="rf-field">Склад-источник
					<select value={sourceStore} onChange={(e) => void loadItems(e.target.value)}>
						<option value="">— выбери склад —</option>
						{stores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
					</select>
				</label>
			</div>
			{sourceStore && (
				<label className="rf-field rf-wide">Аппарат (из остатков склада)
					<input type="search" value={q} placeholder="поиск по названию / id" onChange={(e) => setQ(e.target.value)} />
					{loadingItems ? <p className="muted small">Гружу остатки…</p> : (
						<div className="rf-suggest" style={{ position: 'static', maxHeight: 300 }}>
							{filtered.length === 0 ? <p className="muted small">Нет позиций с остатком на складе.</p> : filtered.slice(0, 100).map((i) => (
								<button key={i.productId} type="button" className={`rf-suggest-item${picked?.productId === i.productId ? ' active' : ''}`} onClick={() => setPicked({ productId: i.productId, name: i.name })}>
									{i.name} <span className="muted small">· #{i.productId} · остаток {i.qty}</span>
								</button>
							))}
						</div>
					)}
				</label>
			)}
			{picked && <p className="muted small">Выбран: <b>{picked.name}</b> (#{picked.productId}) → уйдёт в ремонт со склада «{sourceStore}».</p>}
			{err && <p className="error">⛔ {err}</p>}
			<div className="rf-actions">
				<button className="btn-primary" onClick={() => void submit()} disabled={saving || !picked}>{saving ? 'Создаю…' : 'В ремонт'}</button>
				<button className="btn-secondary" onClick={onCancel} disabled={saving}>Отмена</button>
			</div>
		</div>
	);
}

function RepairCard({ repair, mock, canEditPrice, onBack, onEdit, onSaveInternalComment, onPrint, onIssuePrint, onStatus, onSetPay, onRequestPriceApproval, onSetIssueStore, onDelete }: {
	repair: Repair; mock: boolean; canEditPrice: boolean; onBack: () => void; onEdit: () => void; onSaveInternalComment: (comment: string) => Promise<void>; onPrint: () => void; onIssuePrint: () => void; onStatus: (s: RepairStatus) => Promise<void>; onSetPay: (p: 'warranty' | 'paid', cost: number | null, ourPrice: number | null) => Promise<{ dealCreated: boolean; dealNoContact: boolean }>; onRequestPriceApproval: (cost: number | null, ourPrice: number | null) => Promise<{ dealCreated: boolean; dealNoContact: boolean }>; onSetIssueStore: (store: string) => Promise<void>; onDelete: () => Promise<void>;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [payBusy, setPayBusy] = useState(false);
	const [costVal, setCostVal] = useState<string>(repair.cost != null ? String(repair.cost) : '');
	const [ourVal, setOurVal] = useState<string>(repair.ourPrice != null ? String(repair.ourPrice) : '');
	const [stErr, setStErr] = useState<string | null>(null);
	const [dealMsg, setDealMsg] = useState<string | null>(null);
	const [issueStores, setIssueStores] = useState<StoreInfo[]>([]);
	const [issueVal, setIssueVal] = useState<string>(repair.issueStore ?? '');
	const [issueBusy, setIssueBusy] = useState(false);
	const [commentEditing, setCommentEditing] = useState(false);
	const [commentBusy, setCommentBusy] = useState(false);
	const [commentVal, setCommentVal] = useState(repair.internalComment ?? '');
	useEffect(() => { if (!mock) fetchStores().then((s) => setIssueStores(s.filter((x) => x.active))).catch(() => setIssueStores([])); }, [mock]);
	const presale = repair.kind === 'presale';
	const canPrintIssue = !presale && (repair.status === 'ready_tt' || repair.status === 'issued');
	// Заморозка: с «принято в офисе» КЛИЕНТСКУЮ карточку трогает только снабжение+. Предпродажный не замораживаем.
	const locked = isLockedStatus(repair.status) && !canEditPrice;
	// Финальная точка: для клиентского — «склад выдачи» (при «Готово к выдаче»); для предпродажного — «склад точки»
	// (выбрать перед «Отправлено на точку», туда вернётся при «Принято на ТТ»).
	const needsIssueStore = (s: RepairStatus): boolean => presale ? (s === 'pre_to_point' || s === 'pre_at_tt') : s === 'ready_tt';
	const costNum = (): number | null => (costVal.trim() !== '' && Number.isFinite(Number(costVal)) ? Number(costVal) : null);
	const ourNum = (): number | null => (ourVal.trim() !== '' && Number.isFinite(Number(ourVal)) ? Number(ourVal) : null);
	function reactDeal(res: { dealCreated: boolean; dealNoContact: boolean }): void {
		if (res.dealCreated) setDealMsg('✓ Сделка по ремонту создана.');
		else if (res.dealNoContact) setDealMsg('⚠ Сделка не создана: у ремонта клиент без привязки к контакту Б24. Привяжи клиента в редактировании.');
		else setDealMsg(null);
	}
	async function change(s: RepairStatus): Promise<void> {
		if (s === repair.status) return;
		// Переход, требующий финальный склад, без выбранного склада — не имеет смысла.
		if (needsIssueStore(s) && !issueVal.trim()) {
			setStErr(presale ? 'Сначала выбери склад точки — туда вернётся товар.' : 'Сначала выбери склад выдачи — туда переместится аппарат.');
			return;
		}
		setBusy(true); setStErr(null);
		try { await onStatus(s); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); }
	}
	async function changeIssue(store: string): Promise<void> {
		const previous = issueVal;
		setIssueVal(store);
		setIssueBusy(true); setStErr(null);
		try {
			await onSetIssueStore(store);
		} catch (e: unknown) {
			setIssueVal(previous);
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setIssueBusy(false);
		}
	}
	async function changePay(p: 'warranty' | 'paid'): Promise<void> {
		if (p === repair.payType) return;
		setPayBusy(true); setStErr(null);
		try { reactDeal(await onSetPay(p, p === 'paid' ? costNum() : null, p === 'paid' ? ourNum() : null)); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); } finally { setPayBusy(false); }
	}
	async function savePrices(): Promise<void> {
		setPayBusy(true); setStErr(null);
		try { reactDeal(await onSetPay('paid', costNum(), ourNum())); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); } finally { setPayBusy(false); }
	}
	async function sendPriceApproval(): Promise<void> {
		setPayBusy(true); setStErr(null);
		try {
			reactDeal(await onRequestPriceApproval(costNum(), ourNum()));
			setDealMsg('Цена отправлена на согласование в чат точки.');
		} catch (e: unknown) {
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setPayBusy(false);
		}
	}
	async function remove(): Promise<void> {
		if (busy) return;
		if (!window.confirm(`Удалить ремонт #${repairNo(repair)}? Действие необратимо.`)) return;
		setBusy(true); setStErr(null);
		try { await onDelete(); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); setBusy(false); }
	}
	async function saveInternalComment(): Promise<void> {
		setCommentBusy(true); setStErr(null);
		try {
			await onSaveInternalComment(commentVal.trim());
			setCommentEditing(false);
		} catch (error) {
			setStErr(String(error instanceof Error ? error.message : error));
		} finally {
			setCommentBusy(false);
		}
	}
	const row = (label: string, value: string): JSX.Element => (
		<div className="rc-row"><span className="rc-label">{label}</span><span className="rc-val">{value || '—'}</span></div>
	);
	return (
		<div className="repair-card">
			<div className="base-backbar"><button className="btn-secondary" onClick={onBack}>← К списку</button></div>
			<div className="rc-head">
				<h2>Ремонт #{repairNo(repair)}{repair.status === 'issued' && <span className="status-done"> · завершён</span>}</h2>
				<div className="rc-head-actions">
					<button className="btn-secondary" onClick={() => presale ? setCommentEditing(true) : onEdit()} disabled={locked} title={locked ? 'Принят в офисе — правит только снабжение' : undefined}>✎ {presale ? 'Редактировать комментарий' : 'Редактировать'}</button>
					<button className="btn-secondary" onClick={onPrint}>Акт приёма</button>
					{canPrintIssue && <button className="btn-primary" onClick={onIssuePrint}>Акт выдачи</button>}
					<button className="btn-danger" disabled={busy || locked} onClick={() => void remove()} title={locked ? 'Принят в офисе — удалить может только снабжение' : 'Удалить ремонт (необратимо)'}>🗑 Удалить</button>
				</div>
			</div>
			{locked && <p className="muted small">🔒 Ремонт принят в офисе — изменения (поля, цены, статус) доступны только снабжению.</p>}
			{(repair.taskId || (!presale && repair.dealId)) && <div className="rc-related-links">
				{repair.taskId ? <button type="button" className="rc-related-link" onClick={() => openTask(repair.taskId!)}><span>Задача</span><b>#{repair.taskId}</b></button> : null}
				{!presale && repair.dealId ? <button type="button" className="rc-related-link" onClick={() => openDeal(repair.dealId!)}><span>Сделка</span><b>#{repair.dealId}</b></button> : null}
			</div>}
			{repair.taskWarning ? <p className="error">⚠ {repair.taskWarning}</p> : null}

			<div className="rc-status">
				<span className="rc-label">Статус</span>
				<select value={repair.status} disabled={busy || locked} onChange={(e) => void change(e.target.value as RepairStatus)}>
					{flowFor(repair.kind).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
				</select>
				{busy && <span className="muted small">сохраняю…</span>}
				{mock && <span className="muted small">(dev: статус не пишется)</span>}
			</div>

			<div className="rc-status">
				<span className="rc-label">{presale ? 'Склад точки' : 'Склад выдачи'}</span>
				<select value={issueVal} disabled={issueBusy || locked} onChange={(e) => void changeIssue(e.target.value)} title={presale ? 'Куда вернуть товар на точку. Выбери перед «Отправлено на точку» — туда товар встанет при «Принято на ТТ».' : 'Куда переместить аппарат при «Готово к выдаче». Клиент может забрать на другой точке.'}>
					<option value="">— не выбран —</option>
					{issueStores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
				</select>
				{issueBusy && <span className="muted small">сохраняю…</span>}
				{!issueVal.trim() && <span className="muted small">{presale ? 'выбери перед «Отправлено на точку»' : 'выбери перед «Готово к выдаче»'}</span>}
			</div>

			{!presale && (
				<div className="rc-pay">
					<span className="rc-label">Вид ремонта</span>
					<div className="rc-pay-toggle">
						<button className={`btn-secondary${repair.payType === 'warranty' ? ' active' : ''}`} disabled={payBusy || locked} onClick={() => void changePay('warranty')}>Гарантийный</button>
						<button className={`btn-secondary${repair.payType === 'paid' ? ' active' : ''}`} disabled={payBusy || locked} onClick={() => void changePay('paid')}>Платный</button>
					</div>
					{repair.payType === 'paid' && canEditPrice && (
						<span className="rc-pay-cost">
							<input type="number" min="0" step="1" value={costVal} placeholder="цена СЦ, ₽" disabled={payBusy} onChange={(e) => setCostVal(e.target.value)} title="Цена ремонта СЦ" />
							<input type="number" min="0" step="1" value={ourVal} placeholder="наша цена, ₽" disabled={payBusy} onChange={(e) => setOurVal(e.target.value)} title="Наша цена (→ сделка)" />
							<button className="btn-secondary" disabled={payBusy} onClick={() => void savePrices()}>Сохранить ₽</button>
							<button className="btn-primary" disabled={payBusy || (costNum() == null && ourNum() == null)} onClick={() => void sendPriceApproval()}>Согласовать цену</button>
						</span>
					)}
					{repair.payType === 'paid' && !canEditPrice && (
						<span className="rc-pay-cost">СЦ <b>{repair.cost != null ? money(repair.cost) : '—'}</b> · наша <b>{repair.ourPrice != null ? money(repair.ourPrice) : '—'}</b> <span className="muted small">цены меняет руководитель / закупка</span></span>
					)}
					{payBusy && <span className="muted small">сохраняю…</span>}
				</div>
			)}
			{!presale && !repair.dealId && repair.client.contactId == null && <p className="muted small">⚠ Чтобы создать сделку ремонта — привяжи клиента к контакту Б24 (в редактировании).</p>}
			{dealMsg && <p className="muted small">{dealMsg}</p>}
			{stErr && <p className="error">⛔ {stErr}</p>}
			{presale && commentEditing && (
				<div className="rc-comment-editor">
					<label>Внутренний комментарий
						<textarea rows={3} maxLength={2000} value={commentVal} onChange={(event) => setCommentVal(event.target.value)} autoFocus />
					</label>
					<div className="rc-comment-editor-actions">
						<button className="btn-primary" type="button" disabled={commentBusy} onClick={() => void saveInternalComment()}>{commentBusy ? 'Сохраняю…' : 'Сохранить'}</button>
						<button className="btn-secondary" type="button" disabled={commentBusy} onClick={() => { setCommentVal(repair.internalComment ?? ''); setCommentEditing(false); }}>Отмена</button>
					</div>
				</div>
			)}

			<div className="rc-body">
				{presale ? (
					<>
						{row('Тип', '🛠 Предпродажный ремонт')}
						{row('Аппарат', repair.device || (repair.productId != null ? `#${repair.productId}` : ''))}
						{row('Склад-источник', repair.sourceStore ?? '')}
						{row('Сейчас на складе', repair.repairStore ?? '')}
						{row('Внутренний комментарий', repair.internalComment ?? '')}
						{row('Принят', ruDateTime(repair.createdAt))}
						{repair.createdByName && row('Принял', repair.createdByName)}
					</>
				) : (
					<>
						{row('Клиент', repair.client.name)}
						{row('Телефон', repair.client.phone)}
						{row('Оборудование', [repair.device, repair.model].filter(Boolean).join(' '))}
						{row('Серийный №', repair.serial)}
						{row('Торговая точка', repair.point)}
						{repair.payType === 'paid' && row('Цена ремонта СЦ', repair.cost != null ? money(repair.cost) : '—')}
						{repair.payType === 'paid' && row('Наша цена', repair.ourPrice != null ? money(repair.ourPrice) : '—')}
						{row('Внешний вид и комплектация', repair.appearance)}
						{row('Неисправность', repair.defect)}
						{row('Внутренний комментарий', repair.internalComment ?? '')}
						{row('Комментарий СЦ', repair.comment)}
						{row('Принят', ruDateTime(repair.createdAt))}
						{repair.createdByName && row('Принял', repair.createdByName)}
					</>
				)}
			</div>

			{repair.files.length > 0 && (
				<div className="rc-files">
					<span className="rc-label">Документы</span>
					<div className="rc-files-list">
						{repair.files.map((f, i) => (
							<a key={`${f.id}-${i}`} className="rc-file" href={f.url || '#'} onClick={(event) => { event.preventDefault(); void openRepairFile(f); }}>📄 {f.name}</a>
						))}
					</div>
				</div>
			)}

			{repair.photos.length > 0 && (
				<div className="rf-photos">
					{repair.photos.map((p, i) => <div key={`${p.id}-${i}`} className="rf-photo"><img src={repairFileHref(p)} alt={p.name} /></div>)}
				</div>
			)}

			{repair.history.length > 0 && (
				<div className="rc-history">
					<span className="rc-label">История</span>
					<div className="rc-history-list">
						{[...repair.history].slice().reverse().map((h, i) => (
							<div key={i} className="rc-hist-row">
								<span className="rc-hist-when">{ruDateTime(h.at)}</span>
								<span className="rc-hist-what">{h.note ? h.note : (STATUS_LABEL[h.status] ?? h.status)}</span>
								<span className="rc-hist-who">{h.byName || (h.byId ? `#${h.byId}` : '—')}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

/** Сводное сопроводительное письмо для передачи выбранного оборудования в сервис. */
function RepairDispatchBlank({ repairs, contact, onBack }: { repairs: Repair[]; contact: DispatchContact; onBack: () => void }): JSX.Element {
	return (
		<div className="repair-blank-wrap repair-dispatch-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Выбрано ремонтов: {repairs.length}</span>
				<button className="btn-primary" onClick={() => window.print()}>Печать</button>
			</div>
			<div className="repair-blank repair-dispatch-letter">
				<div className="blank-head">
					<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
					<div className="repair-dispatch-meta">
						<span>Дата: {ruDate(new Date().toISOString())}</span>
						{contact.name && <span>Контактное лицо: {contact.name}</span>}
						{contact.phone && <span>Телефон: {contact.phone}</span>}
					</div>
				</div>
				<div className="blank-title">Сопроводительное письмо</div>
				<table className="blank-table repair-dispatch-table">
					<thead><tr><th>Номер ремонта</th><th>Модель</th><th>Серийный номер</th><th>Неисправность</th><th>Комплектация</th></tr></thead>
					<tbody>
						{repairs.map((repair) => (
							<tr key={repair.id}>
								<td>#{repairNo(repair)}</td>
								<td>{repair.model || repair.device || '—'}</td>
								<td>{repair.serial || '—'}</td>
								<td>{repair.defect || '—'}</td>
								<td>{repairCompleteness(repair)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

function repairHistoryDate(repair: Repair, status: RepairStatus): string {
	const entry = repair.history.find((row) => row.status === status && !row.note);
	return entry?.at ? ruDate(entry.at) : '';
}

/** Акт передачи клиенту: два экземпляра, только известные системе факты без сведений о деталях СЦ. */
function RepairIssueBlank({ repair, onBack }: { repair: Repair; onBack: () => void }): JSX.Element {
	const acceptedAt = ruDate(repair.createdAt);
	const completedAt = repairHistoryDate(repair, 'ready_tt');
	const issuedAt = repairHistoryDate(repair, 'issued') || ruDate(new Date().toISOString());
	const equipment = [repair.device, repair.model].filter(Boolean).join(' ') || '—';
	const issuePoint = repair.issueStore || repair.point || '—';
	const repairPrice = repair.payType === 'paid' && repair.ourPrice != null ? money(repair.ourPrice) : '0 ₽';
	const workText = repair.comment.trim() || '—';
	const copy = (label: string): JSX.Element => (
		<div className="blank-copy repair-issue-copy">
			<div className="blank-head repair-issue-head">
				<div>
					<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
					<div className="repair-issue-org">{ACT_REQUISITE}</div>
					<div className="repair-issue-muted">Торговая точка выдачи: {issuePoint}</div>
				</div>
				<span className="blank-copylabel">Ремонт № {repairNo(repair)} · {label}</span>
			</div>

			<div className="blank-title repair-issue-title">Акт выдачи оборудования после ремонта № {repairNo(repair)}</div>
			<div className="repair-issue-subtitle">Составлен {issuedAt} в двух экземплярах</div>

			<div className="repair-issue-parties">
				<div><span>Исполнитель</span><b>{ACT_REQUISITE}</b></div>
				<div><span>Клиент</span><b>{repair.client.name || '—'}</b><small>{repair.client.phone}</small></div>
			</div>

			<table className="blank-table repair-issue-table">
				<tbody>
					<tr><th>Оборудование</th><td>{equipment}</td><th>Серийный номер</th><td>{repair.serial || '—'}</td></tr>
					<tr><th>Принято от клиента</th><td>{acceptedAt || '—'}</td><th>Выдано клиенту</th><td>{issuedAt}</td></tr>
					<tr><th>Ремонт завершён</th><td colSpan={3}>{completedAt || '—'}</td></tr>
				</tbody>
			</table>

			<div className="repair-issue-section">
				<span>Заявленная неисправность</span>
				<p>{repair.defect || '—'}</p>
			</div>
			<div className="repair-issue-section">
				<span>Состояние и комплектность при приёме</span>
				<p>{repair.appearance || '—'}</p>
			</div>
			<div className="repair-issue-section">
				<span>Выполненные работы</span>
				<p>{workText}</p>
			</div>

			<div className="repair-issue-terms">
				<div><span>Вид ремонта</span><b>{repair.payType === 'warranty' ? '☑ Гарантийный   ☐ Платный' : '☐ Гарантийный   ☑ Платный'}</b></div>
				<div><span>Стоимость ремонта</span><b>{repairPrice}</b></div>
			</div>

			<div className="repair-issue-section repair-issue-handover">
				<span>Передача клиенту</span>
				<p><b>Комплектность и внешний вид:</b> соответствуют состоянию, зафиксированному при приёме, кроме замечаний ниже.</p>
				<p><b>Проверка:</b> ☐ проведена в присутствии клиента &nbsp;&nbsp; ☐ клиент отказался от проверки.</p>
				<p><b>Замечания клиента при выдаче:</b> __________________________________________________________</p>
			</div>

			<div className="repair-issue-receipt">
				Оборудование и один экземпляр настоящего акта получил. Комплектность и внешний вид при выдаче проверены,
				результат выполненных работ продемонстрирован в объёме, доступном в месте выдачи. Подпись подтверждает
				факт передачи оборудования и зафиксированные выше обстоятельства, но не ограничивает права клиента
				в отношении скрытых недостатков и иные права, предусмотренные законом.
			</div>

			<div className="repair-issue-signatures">
				<div><span>Выдал, представитель исполнителя</span><p>____________ / ________________________</p></div>
				<div><span>Получил, клиент</span><p>____________ / {repair.client.name || '________________________'}</p></div>
			</div>

			<div className="repair-issue-footer">
				При повторном обращении по той же неисправности рекомендуется предъявить этот акт.
			</div>
		</div>
	);

	return (
		<div className="repair-blank-wrap repair-issue-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Два экземпляра: клиенту и торговой точке</span>
				<button className="btn-primary" onClick={() => window.print()}>Печать</button>
			</div>
			<div className="repair-blank repair-issue-blank">
				<div className="blank-page">{copy('экземпляр клиента')}</div>
				<div className="blank-page">{copy('экземпляр точки')}</div>
			</div>
		</div>
	);
}

/** Печатный «Акт сдачи оборудования в ремонт» (1–3 экземпляра). @media print прячет всё кроме акта. */
function RepairBlank({ repair, onBack }: { repair: Repair; onBack: () => void }): JSX.Element {
	const [copies, setCopies] = useState(2);
	const equip = `${[repair.device, repair.model].filter(Boolean).join(' ')}${repair.serial ? ` / SN ${repair.serial}` : ''}` || '—';
	const copy = (label: string): JSX.Element => (
		<div className="blank-copy">
			<div className="blank-head">
				<img className="blank-logo" src={REPAIR_LOGO} alt="Умный дом" />
				<span className="blank-copylabel">Ремонт № {repairNo(repair)}{label ? ` · ${label}` : ''}</span>
			</div>
			<div className="blank-title">Акт сдачи оборудования в ремонт</div>
			<div className="blank-listlabel">Список оборудования:</div>
			<table className="blank-table">
				<thead><tr><th>Наименование (Серийный номер)</th><th className="blank-qty">Количество</th></tr></thead>
				<tbody>
					<tr><td>{equip}</td><td className="blank-qty">1</td></tr>
					<tr><td>&nbsp;</td><td className="blank-qty">&nbsp;</td></tr>
				</tbody>
			</table>
			<div className="blank-lines">
				<div>► Торговая точка: {repair.point || '—'}</div>
				<div>► Клиент: {[repair.client.name, repair.client.phone].filter(Boolean).join('  ') || '—'}</div>
				<div>► Менеджер: {repair.createdByName || '—'}</div>
				<div>Неисправность: со слов клиента: {repair.defect || '—'}</div>
				<div>Внешний вид и комплектация: {repair.appearance || '—'}</div>
				<div>Дата сдачи оборудования: {ruDate(repair.createdAt)}</div>
			</div>
			<div className="blank-signs">
				<div className="blank-sign"><div>Подпись покупателя:</div><div className="blank-signline">___________ /____________________________/</div></div>
				<div className="blank-sign"><div>Подпись продавца:</div><div className="blank-signline">___________ /____________________________/</div></div>
			</div>
			<div className="blank-req">{ACT_REQUISITE}</div>
			<div className="blank-mp">М. П.</div>
		</div>
	);
	const labels = Array.from({ length: copies }, (_, i) => COPY_LABELS[i] ?? `экземпляр ${i + 1}`);
	return (
		<div className="repair-blank-wrap">
			<div className="blank-toolbar no-print">
				<button className="btn-secondary" onClick={onBack}>← Назад</button>
				<span className="muted small">Экземпляров:</span>
				{[1, 2, 3].map((n) => (
					<button key={n} className={`btn-secondary${copies === n ? ' active' : ''}`} onClick={() => setCopies(n)}>{n}</button>
				))}
				<button className="btn-primary" onClick={() => window.print()}>🖨 Печать</button>
			</div>
			<div className="repair-blank">
				{labels.map((lb, i) => (
					<div key={i} className="blank-page">{copy(lb)}</div>
				))}
			</div>
		</div>
	);
}

function Shell({ children }: { children: JSX.Element }): JSX.Element {
	return (
		<div className="inv repairs-shell">
			<header>
				<h1>🔧 Ремонты</h1>
				<p className="subtitle">Приём оборудования и сдача в ремонт · приём → отправлено → вернулось → выдано</p>
			</header>
			<section>{children}</section>
		</div>
	);
}
