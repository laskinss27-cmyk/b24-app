import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
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
	syncRepairDealNow,
	setRepairIssueStore,
	deleteRepair,
	type NewRepairInput,
	type Repair,
} from './b24.js';
import {
	repairDisplayNumber as repairNo,
} from './repair-display.js';
import { RepairDispatchBlank, type RepairDispatchContact as DispatchContact } from './RepairDispatchBlank.js';
import { RepairIssueBlank } from './RepairIssueBlank.js';
import { RepairIntakeBlank } from './RepairIntakeBlank.js';
import { RepairList } from './RepairList.js';
import { PresaleRepairForm } from './PresaleRepairForm.js';
import { RepairForm } from './RepairForm.js';
import { RepairCard } from './RepairCard.js';

/**
 * Модуль «Ремонты» (RMA) — приём оборудования и сдача поставщику-производителю.
 * Всё наше: страница, список, форма, статусы, печатный бланк. Данные в нашем
 * store (ctv_repairs). От Б24 берём клиента (поиск контакта) и Диск (фото).
 * Вход: пункт левого меню (view='repairs'). Канарейка — как у Базы/Реализаций.
 */

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

type Phase = { k: 'init' } | { k: 'ready' };
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

	if (screen.k === 'print') return <RepairIntakeBlank repair={screen.repair} onBack={() => setScreen({ k: 'card', repair: screen.repair })} />;
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
				<PresaleRepairForm
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
						const sync = ctx.__mock
							? { dealCreated: false, dealNoContact: false, syncWarning: null }
							: await updateRepairStatus(screen.repair.id, st);
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
						return sync;
					}}
					onSetPay={async (payType, cost, ourPrice) => {
						const res = ctx.__mock
							? { payType, cost, ourPrice, dealId: screen.repair.dealId, dealCreated: false, dealNoContact: false, syncWarning: null }
							: await setRepairPayType(screen.repair.id, payType, cost, ourPrice);
						const next = { ...screen.repair, payType: res.payType, cost: res.cost, ourPrice: res.ourPrice, dealId: res.dealId ?? screen.repair.dealId };
						setScreen({ k: 'card', repair: next });
						setRepairs((prev) => prev.map((x) => (x.id === next.id ? next : x)));
						return { dealCreated: res.dealCreated, dealNoContact: res.dealNoContact, syncWarning: res.syncWarning };
					}}
					onRequestPriceApproval={async (cost, ourPrice) => {
						const res = ctx.__mock
							? { repair: { ...screen.repair, payType: 'paid' as const, cost, ourPrice }, dealCreated: false, dealNoContact: false, syncWarning: null }
							: await requestRepairPriceApproval(screen.repair.id, cost, ourPrice);
						setScreen({ k: 'card', repair: res.repair });
						setRepairs((prev) => prev.map((x) => (x.id === res.repair.id ? res.repair : x)));
						return { dealCreated: res.dealCreated, dealNoContact: res.dealNoContact, syncWarning: res.syncWarning };
					}}
					onSyncDeal={async () => {
						const res = ctx.__mock
							? { repair: screen.repair, dealCreated: false, dealNoContact: false, syncWarning: null }
							: await syncRepairDealNow(screen.repair.id);
						setScreen({ k: 'card', repair: res.repair });
						setRepairs((prev) => prev.map((x) => (x.id === res.repair.id ? res.repair : x)));
						return { dealCreated: res.dealCreated, dealNoContact: res.dealNoContact, syncWarning: res.syncWarning };
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
