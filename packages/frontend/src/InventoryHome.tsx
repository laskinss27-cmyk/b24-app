import { Fragment, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchStores,
	fetchUsers,
	fetchSections,
	listInventories,
	createInventory,
	claimPoint,
	deleteInventory,
	reopenPoint,
	getInitiators,
	fetchCurrentUser,
	fetchCurrentAppAccess,
	isPortalAdmin,
	withTimeout,
	previewErpDoc,
	saveErpDoc,
	submitErpDoc,
	type ErpInvDoc,
	type ErpInvDocuments,
	type ErpInvDocumentState,
	type ErpRecoLine,
	type Inventory,
	type InvPoint,
	type InvResult,
	type SimpleUser,
	type StoreInfo,
} from './b24.js';
import { InventoryCount } from './InventoryReport.js';
import { inventoryStoreVisible } from './inventory-settings.js';
import { inventoryMoney } from './inventory-money.js';

/**
 * Модуль инвентаризации (вход из левого меню). Своя сущность, без привязки к задаче.
 * v1: инициатор создаёт инвентаризацию (точки + срок) и видит список.
 * v2: менеджер берёт свою точку («Начал выполнение») → считает → отправляет;
 *     инициатор видит живую сводку статусов точек (не начато / в работе / отправлено).
 *
 * Канарейка: модуль виден только бета-юзеру (Сергей 1858). Бета = инициатор (для теста),
 * но он же может пройти точку как менеджер — кнопки действий есть и у инициатора.
 */

/** Имя инвентаризации по умолчанию (поле ввода названия убрано — Сергей, 2026-06-05). */
const INV_TITLE = 'Инвентаризация';

type Phase = { k: 'init' } | { k: 'error'; msg: string } | { k: 'ready' };

/** Активный подсчёт точки (открыт экран InventoryCount). */
interface Counting {
	inventoryId: string;
	storeId: number;
	storeName: string;
	draft?: Record<number, number> | undefined;
	comments?: Record<number, string> | undefined;
	/** Охват (#13): разделы инвентаризации — прокидываем в подсчёт. */
	sectionIds?: number[] | undefined;
	/** 'act' — второй раунд (сверка акта разногласий), иначе обычный подсчёт. */
	mode?: 'count' | 'act' | undefined;
	/** Режим акта: расхождения 1-го раунда (что показываем) + размер инвентаризации (для слияния). */
	actLines?: InvResult['lines'] | undefined;
	total1?: number | undefined;
}

const MOCK_STORES: StoreInfo[] = [
	{ id: 8, title: 'Максидом Дунайский 64', active: true },
	{ id: 10, title: 'Максидом Богатырский 15', active: true },
	{ id: 22, title: 'Максидом Фаворского 12', active: true },
];
const MOCK_USERS: SimpleUser[] = [
	{ id: '1', name: 'Дранишников Владимир' },
	{ id: '986', name: 'Бекасов Игорь' },
	{ id: '18', name: 'Иванов Иван' },
	{ id: '34', name: 'Петров Пётр' },
];
const MOCK_SECTIONS: { id: number; name: string }[] = [
	{ id: 156, name: 'Кабель и расходники' },
	{ id: 190, name: 'Домофоны' },
	{ id: 194, name: 'Камеры' },
];

/** Статус крайнего срока для списка (браузерная дата — это фронт, не workflow). */
function deadlineStatus(deadline: string): { text: string; cls: string; days: number } | null {
	if (!deadline) return null;
	const dd = new Date(`${deadline}T00:00:00`);
	if (Number.isNaN(dd.getTime())) return null;
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const days = Math.round((dd.getTime() - today.getTime()) / 86400000);
	if (days < 0) return { text: 'Просрочено', cls: 'overdue', days };
	if (days === 0) return { text: 'Срок сегодня', cls: 'soon', days };
	if (days === 1) return { text: 'Остался 1 день', cls: 'soon', days };
	return { text: `До ${dd.toLocaleDateString('ru-RU')}`, cls: 'ok', days };
}

/** Текст и цвет статуса точки для компактного реестра. */
function pointState(p: InvPoint): { text: string; tone: string } {
	const st = p.status ?? 'idle';
	if (st === 'reconciled' || st === 'submitted' || st === 'act') return { text: 'Готово к проведению', tone: 'green' };
	if (st === 'in_progress') return { text: 'В работе', tone: 'blue' };
	return { text: p.responsibleName ? 'Назначено' : 'Не начато', tone: 'gray' };
}

type InventoryStatusFilter = 'all' | 'active' | 'attention' | 'overdue' | 'closed';
type InventorySort = 'newest' | 'oldest' | 'deadline' | 'discrepancies';

function inventoryDiscrepancies(inv: Inventory): number {
	return inv.points.reduce((sum, point) => sum + (point.result?.discrepancies ?? 0), 0);
}

function inventoryNeedsAttention(inv: Inventory): boolean {
	if (inv.status === 'closed') return false;
	return inv.points.some((point) => point.status === 'submitted' || point.status === 'act') || inventoryDiscrepancies(inv) > 0;
}

function inventoryIsOverdue(inv: Inventory): boolean {
	return inv.status === 'active' && (deadlineStatus(inv.deadline)?.days ?? 0) < 0;
}

function inventorySearchText(inv: Inventory): string {
	return [inv.id, inv.title, inv.createdAt, inv.deadline, ...inv.points.flatMap((point) => [point.storeName, point.responsibleName])]
		.join(' ')
		.toLocaleLowerCase('ru-RU')
		.replace(/ё/g, 'е');
}

function inventoryCreatedLabel(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU');
}

function inventoryDeadlineStatus(inv: Inventory): { text: string; cls: string; days: number } | null {
	if (inv.status === 'closed') return null;
	const state = deadlineStatus(inv.deadline);
	return state;
}

export function InventoryHome(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [me, setMe] = useState<SimpleUser>({ id: '', name: '' });
	const [isInitiator, setIsInitiator] = useState(false);
	const [inventories, setInventories] = useState<Inventory[]>([]);
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [users, setUsers] = useState<SimpleUser[]>([]);
	const [sections, setSections] = useState<{ id: number; name: string }[]>([]);

	const [creating, setCreating] = useState(false);
	const [picked, setPicked] = useState<Record<number, string>>({});
	const [deadline, setDeadline] = useState('');
	const [notify, setNotify] = useState<string[]>([]);
	const [pickedSections, setPickedSections] = useState<number[]>([]);
	const [saving, setSaving] = useState(false);
	const [deadlineError, setDeadlineError] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);
	const [storageWarn, setStorageWarn] = useState<string | null>(null);
	const [inventorySearch, setInventorySearch] = useState('');
	const [inventoryStatus, setInventoryStatus] = useState<InventoryStatusFilter>('all');
	const [inventoryStore, setInventoryStore] = useState('all');
	const [inventorySort, setInventorySort] = useState<InventorySort>('newest');
	const [expandedInventory, setExpandedInventory] = useState<string | null>(null);
	const [reloading, setReloading] = useState(false);
	const [lastUpdatedAt, setLastUpdatedAt] = useState('');

	const [counting, setCounting] = useState<Counting | null>(null);
	const [actionErr, setActionErr] = useState<string | null>(null);
	/** Ключ `invId:storeId` раскрытой точки (просмотр расхождений). */
	const [expanded, setExpanded] = useState<string | null>(null);
	/** Открытая модалка QR точки (мобильный подсчёт): какую точку показываем. */
	const [qrFor, setQrFor] = useState<{ invId: string; storeId: number; storeName: string } | null>(null);
	/** Документы инвентаризации в ядре: списание недостачи и оприходование излишков. */
	const [erpFor, setErpFor] = useState<{ invId: string; storeId: number; storeName: string } | null>(null);

	useEffect(() => {
		if (ctx.__mock) {
			setMe({ id: '1858', name: 'Сергей Ласкин (dev)' });
			setIsInitiator(true);
			setStores(MOCK_STORES);
			setUsers(MOCK_USERS);
			setSections(MOCK_SECTIONS);
			setInventories([
				{
					id: '21652',
					title: 'Инвентаризация 22.09',
					status: 'active',
					deadline: '2026-09-25',
					createdById: '1',
					createdAt: '2026-09-22T08:30:00.000Z',
					points: [
						{ storeId: 8, storeName: 'Максидом Дунайский 64', responsibleId: '18', responsibleName: 'Иванов Иван', status: 'in_progress', startedAt: '2026-09-22' },
						{ storeId: 10, storeName: 'Максидом Богатырский 15', responsibleId: '', responsibleName: '', status: 'idle' },
						{
							storeId: 22, storeName: 'Максидом Фаворского 12', responsibleId: '34', responsibleName: 'Петров Пётр', status: 'reconciled',
							submittedAt: '2026-09-22',
							result: { counted: 41, total: 42, discrepancies: 2, lines: [
								{ productId: 1924, name: 'IP камера купольная', book: 18, fact: 16, diff: -2 },
								{ productId: 2050, name: 'Кабель UTP 5E (бухта)', book: 7, fact: 8, diff: 1 },
							] },
							draft: { 1924: 16, 2050: 8 },
						},
					],
				},
				{
					id: '21651',
					title: 'Инвентаризация 15.09',
					status: 'closed',
					deadline: '2026-09-18',
					createdById: '1858',
					createdAt: '2026-09-15T10:15:00.000Z',
					points: [{
						storeId: 8, storeName: 'Максидом Дунайский 64', responsibleId: '1', responsibleName: 'Дранишников Владимир', status: 'reconciled', submittedAt: '2026-09-18',
						result: { counted: 126, total: 126, discrepancies: 0, lines: [] },
						erpDocs: {},
					}],
				},
			]);
			setLastUpdatedAt(new Date().toISOString());
			setPhase({ k: 'ready' });
			return;
		}
		const bx = window.BX24;
		if (!bx) {
			setPhase({ k: 'error', msg: 'BX24 SDK не загружен.' });
			return;
		}
		bx.init(() => {
			void (async () => {
				const meUser = await withTimeout(fetchCurrentUser(), 15000, 'user.current');
					const uid = meUser.id;
				let initiators: string[] = [];
				try {
					initiators = await withTimeout(getInitiators(), 8000, 'app.option.get');
				} catch {
					initiators = [];
				}
				// Явное право приложения сильнее старого списка инициаторов.
				const legacyInitiator = isPortalAdmin() || initiators.includes(uid);
				const appAccess = await withTimeout(fetchCurrentAppAccess(), 20000, 'access-control/me').catch(() => null);
				const manageDecision = appAccess?.decisions['inventory.manage'] ?? 'inherit';
				// Внутрь рабочего места «Снаб» уже допускает его собственная внешняя проверка.
				// Поэтому любой сотрудник снабжения может полноценно работать с инвентаризацией.
				const init = ctx.view === 'supply'
					? true
					: manageDecision === 'allow' ? true : manageDecision === 'deny' ? false : legacyInitiator;
				setIsInitiator(init);

				const sts = await withTimeout(fetchStores(), 15000, 'core stores');
				// Создавать инвентаризацию может любой сотрудник, который открыл раздел.
				// Для формы всем нужны списки ответственных и разделов каталога; права
				// инициатора по-прежнему управляют только сверкой и документами.
				const usrs = await withTimeout(fetchUsers(), 15000, 'user.get').catch(() => [] as SimpleUser[]);
				const secs = await withTimeout(fetchSections(), 15000, 'catalog.section.list').catch(() => [] as { id: number; name: string }[]);
				setMe(meUser);
				setStores(sts.filter((s) => s.active && inventoryStoreVisible(s.title)));
				setUsers(usrs);
				setSections(secs);
				setPhase({ k: 'ready' });

				void (async () => {
					try {
						setInventories(await withTimeout(listInventories(), 20000, 'entity.item.get'));
						setLastUpdatedAt(new Date().toISOString());
					} catch (e: unknown) {
						setStorageWarn(`${String(e instanceof Error ? e.message : e)} (если хранилище не создано — пусть Володя/админ откроет приложение)`);
					}
				})();
			})().catch((e: unknown) => setPhase({ k: 'error', msg: String(e instanceof Error ? e.message : e) }));
		});
	}, [ctx]);

	async function reload(): Promise<void> {
		setReloading(true);
		if (ctx.__mock) {
			setLastUpdatedAt(new Date().toISOString());
			setReloading(false);
			return;
		}
		try {
			setInventories(await withTimeout(listInventories(), 20000, 'list'));
			setLastUpdatedAt(new Date().toISOString());
		} catch {
			/* оставляем текущий список */
		} finally {
			setReloading(false);
		}
	}

	function markPoint(invId: string, storeId: number, patch: Partial<InvPoint>): void {
		setInventories((prev) =>
			prev.map((inv) => (inv.id !== invId ? inv : { ...inv, points: inv.points.map((p) => (p.storeId !== storeId ? p : { ...p, ...patch })) })),
		);
	}

	/** «Начал выполнение» — берём точку себе и открываем подсчёт. */
	async function startPoint(inv: Inventory, p: InvPoint): Promise<void> {
		setActionErr(null);
		if (ctx.__mock) {
			markPoint(inv.id, p.storeId, { status: 'in_progress', responsibleId: me.id, responsibleName: me.name, startedAt: new Date().toISOString() });
		} else {
			try {
				await withTimeout(claimPoint(inv.id, p.storeId, me.id, me.name), 12000, 'claim');
			} catch (e: unknown) {
				setActionErr(String(e instanceof Error ? e.message : e));
				return;
			}
		}
		setCounting({ inventoryId: inv.id, storeId: p.storeId, storeName: p.storeName, draft: p.draft, comments: p.comments, sectionIds: inv.sectionIds });
	}

	function continuePoint(inv: Inventory, p: InvPoint, mode?: 'count' | 'act'): void {
		setActionErr(null);
		setCounting({
			inventoryId: inv.id,
			storeId: p.storeId,
			storeName: p.storeName,
			draft: p.draft,
			comments: p.comments,
			sectionIds: inv.sectionIds,
			mode,
			actLines: mode === 'act' ? p.result?.lines : undefined,
			total1: mode === 'act' ? p.result?.total : undefined,
		});
	}

	/** «Вернуть в работу» (инициатор) — точка снова в работе, пересчёт с прошлых цифр. */
	async function reopenWork(inv: Inventory, p: InvPoint): Promise<void> {
		setActionErr(null);
		if (ctx.__mock) {
			markPoint(inv.id, p.storeId, { status: 'in_progress' });
			return;
		}
		try {
			await withTimeout(reopenPoint(inv.id, p.storeId, me.id), 12000, 'reopen');
			markPoint(inv.id, p.storeId, { status: 'in_progress' });
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		}
	}

	/** Удалить инвентаризацию целиком (необратимо, с подтверждением). */
	async function removeInventory(inv: Inventory): Promise<void> {
		if (!window.confirm(`Удалить «${inv.title}»? Это насовсем.`)) return;
		setActionErr(null);
		if (ctx.__mock) {
			setInventories((prev) => prev.filter((x) => x.id !== inv.id));
			return;
		}
		try {
			await withTimeout(deleteInventory(inv.id), 12000, 'delete');
			setInventories((prev) => prev.filter((x) => x.id !== inv.id));
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		}
	}

	async function submitCreate(): Promise<void> {
		setCreateError(null);
		if (!deadline) {
			setDeadlineError(true);
			return;
		}
		setDeadlineError(false);
		const points: InvPoint[] = Object.entries(picked).map(([sid, rid]) => {
			const store = stores.find((s) => s.id === Number(sid));
			const user = rid ? users.find((u) => u.id === rid) : undefined;
			return {
				storeId: Number(sid),
				storeName: store?.title ?? `склад #${sid}`,
				responsibleId: rid || '',
				responsibleName: user?.name ?? '',
				status: 'idle',
			};
		});
		if (!points.length) {
			setCreateError('Выберите хотя бы одну точку.');
			return;
		}
		setSaving(true);
		const now = new Date().toISOString();
		try {
			if (ctx.__mock) {
				setInventories((prev) => [
					{ id: String(prev.length + 1), title: INV_TITLE, status: 'active', deadline, points, createdById: me.id, createdAt: now, sectionIds: pickedSections },
					...prev,
				]);
			} else {
				await withTimeout(createInventory(INV_TITLE, points, deadline, me.id, notify, pickedSections), 15000, 'create');
				setInventories(await withTimeout(listInventories(), 20000, 'list'));
			}
			setCreating(false);
			setPicked({});
			setDeadline('');
			setDeadlineError(false);
			setCreateError(null);
			setNotify([]);
			setPickedSections([]);
		} catch (e) {
			setPhase({ k: 'error', msg: `Не удалось создать: ${String(e instanceof Error ? e.message : e)}` });
		} finally {
			setSaving(false);
		}
	}

	const availableInventories = useMemo(
		() => isInitiator ? inventories : inventories.filter((inventory) => inventory.status === 'active'),
		[inventories, isInitiator],
	);
	const filteredInventories = useMemo(() => {
		const query = inventorySearch.trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
		return availableInventories
			.filter((inventory) => inventoryStore === 'all' || inventory.points.some((point) => String(point.storeId) === inventoryStore))
			.filter((inventory) => {
				if (inventoryStatus === 'active') return inventory.status === 'active';
				if (inventoryStatus === 'closed') return inventory.status === 'closed';
				if (inventoryStatus === 'attention') return inventoryNeedsAttention(inventory);
				if (inventoryStatus === 'overdue') return inventoryIsOverdue(inventory);
				return true;
			})
			.filter((inventory) => !query || inventorySearchText(inventory).includes(query))
			.sort((left, right) => {
				if (inventorySort === 'oldest') return left.createdAt.localeCompare(right.createdAt);
				if (inventorySort === 'deadline') return (left.deadline || '9999').localeCompare(right.deadline || '9999');
				if (inventorySort === 'discrepancies') return inventoryDiscrepancies(right) - inventoryDiscrepancies(left) || right.createdAt.localeCompare(left.createdAt);
				return right.createdAt.localeCompare(left.createdAt);
			});
	}, [availableInventories, inventorySearch, inventorySort, inventoryStatus, inventoryStore]);
	const registryStats = useMemo(() => ({
		all: availableInventories.length,
		active: availableInventories.filter((inventory) => inventory.status === 'active').length,
		attention: availableInventories.filter(inventoryNeedsAttention).length,
		overdue: availableInventories.filter(inventoryIsOverdue).length,
		closed: availableInventories.filter((inventory) => inventory.status === 'closed').length,
	}), [availableInventories]);

	if (phase.k === 'init') return <Shell><p>Загрузка…</p></Shell>;
	if (phase.k === 'error') return <Shell><p className="error">⛔ {phase.msg}</p></Shell>;

	// Экран подсчёта точки
	if (counting) {
		return (
			<InventoryCount
				inventoryId={counting.inventoryId}
				storeId={counting.storeId}
				storeName={counting.storeName}
				sectionIds={counting.sectionIds}
				me={me}
				initialDraft={counting.draft}
				initialComments={counting.comments}
				mode={counting.mode}
				actLines={counting.actLines}
				total1={counting.total1}
				mock={ctx.__mock}
				onBack={() => {
					setCounting(null);
					void reload();
				}}
				onSubmitted={(result, facts, comments) => {
					if (ctx.__mock) {
						markPoint(counting.inventoryId, counting.storeId, {
							status: counting.mode === 'act' ? 'reconciled' : 'submitted',
							submittedAt: new Date().toISOString(),
							responsibleId: me.id,
							responsibleName: me.name,
							result,
							draft: facts,
							comments,
						});
					} else {
						void reload();
					}
					setCounting(null);
				}}
			/>
		);
	}

	// Действие на точке по статусу/владельцу
	const pointAction = (inv: Inventory, p: InvPoint): JSX.Element | null => {
		const st = p.status ?? 'idle';
		// Считать может КТО УГОДНО в любое время — без блокировки по «взял/назначен».
		// Назначенный ответственный — только для уведомления в задаче, не замок (правило Сергея).
		const key = `${inv.id}:${p.storeId}`;
		const openBtn = p.result ? (
			<button className="btn-mini ghost" onClick={() => setExpanded(expanded === key ? null : key)}>
				{expanded === key ? 'Скрыть' : 'Открыть'}
			</button>
		) : null;
		const reopenBtn = isInitiator ? (
			<button className="btn-mini ghost" onClick={() => void reopenWork(inv, p)}>
				Вернуть в работу
			</button>
		) : null;
		if (st === 'idle') return <button className="btn-mini" onClick={() => void startPoint(inv, p)}>Начал выполнение</button>;
		if (st === 'in_progress') return <button className="btn-mini" onClick={() => continuePoint(inv, p)}>Продолжить</button>;
		if (st === 'submitted' || st === 'act' || st === 'reconciled') {
			const pointDocuments = Object.values(p.erpDocs ?? {});
			const hasDocuments = pointDocuments.length > 0 || Boolean(p.erpDoc);
			const documentsSubmitted = pointDocuments.length > 0
				? pointDocuments.every((document) => document.status === 'submitted')
				: p.erpDoc?.status === 'submitted';
			const erpBadge = hasDocuments ? (documentsSubmitted ? ' ✓' : ' ✎') : '';
			return (
				<>
					{isInitiator && (
						<button className="btn-mini" onClick={() => setErpFor({ invId: inv.id, storeId: p.storeId, storeName: p.storeName })}>
							Провести инвентаризацию{erpBadge}
						</button>
					)}
					{openBtn}
					{reopenBtn}
				</>
			);
		}
		return null;
	};

	const inventoryProgress = (inv: Inventory): { done: number; started: number; total: number; discrepancies: number; counted: number; products: number } => ({
		done: inv.points.filter((point) => point.status === 'reconciled' || point.status === 'submitted' || point.status === 'act').length,
		started: inv.points.filter((point) => point.status && point.status !== 'idle').length,
		total: inv.points.length,
		discrepancies: inventoryDiscrepancies(inv),
		counted: inv.points.reduce((sum, point) => sum + (point.result?.counted ?? 0), 0),
		products: inv.points.reduce((sum, point) => sum + (point.result?.total ?? 0), 0),
	});

	const inventoryDetails = (inv: Inventory): JSX.Element => (
		<div className="inventory-detail-panel">
			<div className="inventory-detail-head">
				<div><strong>Точки инвентаризации</strong><span>{inv.sectionIds?.length ? `Разделов каталога: ${inv.sectionIds.length}` : 'Весь ассортимент выбранных складов'}</span></div>
				{isInitiator && <button className="inventory-delete" type="button" onClick={() => void removeInventory(inv)}>Удалить инвентаризацию</button>}
			</div>
			{inv.points.some((point) => point.result) && <InventoryMoneySummary results={inv.points.flatMap((point) => point.result ? [point.result] : [])} label="Итоги по точкам" partial={inv.points.some((point) => !point.result)} />}
			<div className="inventory-point-list">
				{inv.points.map((point) => {
					const state = pointState(point);
					const key = `${inv.id}:${point.storeId}`;
					return (
						<div className="inventory-point" key={point.storeId}>
							<div className="inventory-point-row">
								<div className="inventory-point-store"><strong>{point.storeName}</strong><span>{point.responsibleName || 'Ответственный не назначен'}</span></div>
								<div><span className={`inventory-pill ${state.tone}`}>{state.text}</span></div>
								<div className="inventory-point-result">
									{point.result ? <><strong>{point.result.counted} из {point.result.total}</strong><span>{point.result.discrepancies ? `Расхождений: ${point.result.discrepancies}` : 'Без расхождений'}</span></> : <span>Результат ещё не отправлен</span>}
								</div>
								<div className="inventory-point-actions">
									{pointAction(inv, point)}
									<button className="btn-mini ghost qr-btn" title="QR для подсчёта с телефона" onClick={() => setQrFor({ invId: inv.id, storeId: point.storeId, storeName: point.storeName })}>QR</button>
								</div>
							</div>
							{expanded === key && point.result && <DiscDetail result={point.result} />}
						</div>
					);
				})}
			</div>
		</div>
	);

	// Создание доступно всем. Полная сводка, удаление, сверка и документы
	// остаются только у инициаторов.
	return (
		<div className="inv inventory-registry">
			<header className="inventory-page-head">
				<div>
					<h1>Инвентаризации</h1>
					<p className="subtitle">Контроль подсчётов, сверки и расхождений по торговым точкам · {me.name}{ctx.__mock ? ' · dev-мок' : ''}</p>
				</div>
				{!creating && <button className="btn-primary inventory-create-button" onClick={() => setCreating(true)}>+ Создать инвентаризацию</button>}
			</header>

			<section className="inventory-kpis" aria-label="Сводка по инвентаризациям">
				<button className={inventoryStatus === 'all' ? 'active' : ''} type="button" onClick={() => setInventoryStatus('all')}><span>Всего</span><strong>{registryStats.all}</strong></button>
				<button className={inventoryStatus === 'active' ? 'active' : ''} type="button" onClick={() => setInventoryStatus('active')}><span>В работе</span><strong>{registryStats.active}</strong></button>
				<button className={`attention${inventoryStatus === 'attention' ? ' active' : ''}`} type="button" onClick={() => setInventoryStatus('attention')}><span>Требуют внимания</span><strong>{registryStats.attention}</strong></button>
				<button className={`danger${inventoryStatus === 'overdue' ? ' active' : ''}`} type="button" onClick={() => setInventoryStatus('overdue')}><span>Просрочены</span><strong>{registryStats.overdue}</strong></button>
				<button className={inventoryStatus === 'closed' ? 'active' : ''} type="button" onClick={() => setInventoryStatus('closed')}><span>Закрыты</span><strong>{registryStats.closed}</strong></button>
			</section>

			{creating && (
				<div className="inv-card create inventory-create-panel">
					<div className="inventory-create-title"><div><strong>Новая инвентаризация</strong><span>Выберите срок, точки и охват каталога</span></div><button className="btn-del" title="Закрыть" onClick={() => setCreating(false)}>✕</button></div>
					<label className="inv-field">Крайний срок сдачи: <input type="date" className={`inv-date${deadlineError ? ' invalid' : ''}`} value={deadline} aria-invalid={deadlineError} onChange={(e) => { setDeadline(e.target.value); setDeadlineError(false); setCreateError(null); }} autoFocus /></label>
					{deadlineError && <p className="inv-validation-error">Укажите дату ревизии.</p>}
					<p className="muted">Точки (ответственного можно не ставить — менеджер сам возьмёт точку):</p>
					<div className="point-pick">
						{stores.map((s) => {
							const checked = picked[s.id] !== undefined;
							return (
								<div className="pick-row" key={s.id}>
									<label>
										<input
											type="checkbox"
											checked={checked}
											onChange={(e) => setPicked((p) => {
												const n = { ...p };
												if (e.target.checked) n[s.id] = '';
												else delete n[s.id];
												return n;
											})}
										/> {s.title}
									</label>
									{checked && (
										<select value={picked[s.id]} onChange={(e) => setPicked((p) => ({ ...p, [s.id]: e.target.value }))}>
											<option value="">— не назначен —</option>
											{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
										</select>
									)}
								</div>
							);
						})}
					</div>
					<p className="muted">Охват — разделы каталога (пусто = весь склад):</p>
					<MultiPick
						placeholder="Поиск раздела…"
						options={sections.length ? [{ id: '0', label: 'Без раздела (товары без категории)' }, ...sections.map((s) => ({ id: String(s.id), label: s.name }))] : []}
						selected={pickedSections.map(String)}
						onChange={(ids) => setPickedSections(ids.map(Number))}
						empty="Разделы не загрузились — будет весь склад."
					/>
					<p className="muted">Кого оповестить задачей (пусто = без оповещения):</p>
					<TagPicker
						placeholder="Начните вводить имя сотрудника…"
						options={users.map((u) => ({ id: u.id, label: u.name }))}
						selected={notify}
						onChange={setNotify}
						empty="Сотрудники не загрузились."
					/>
					<div className="inv-actions">
						<button className="btn-primary" disabled={saving} onClick={() => void submitCreate()}>{saving ? 'Сохраняю…' : 'Создать'}</button>
						<button className="btn-secondary" onClick={() => { setCreating(false); setPicked({}); setDeadline(''); setDeadlineError(false); setCreateError(null); setNotify([]); setPickedSections([]); }}>Отмена</button>
					</div>
					{createError && <p className="inv-validation-error">{createError}</p>}
				</div>
			)}

			{actionErr && <div className="beta-banner">⛔ {actionErr}</div>}
				{storageWarn && <div className="beta-banner">⚠️ Хранилище не отвечает: {storageWarn}. Список может быть пуст, а создание — не сохраниться. Похоже, упёрлись в entity-хранилище — напиши мне, добью.</div>}
			<section className="inventory-filter-panel" aria-label="Фильтры списка">
				<select value={inventoryStatus} onChange={(event) => setInventoryStatus(event.target.value as InventoryStatusFilter)} aria-label="Статус">
					<option value="all">Все статусы</option><option value="active">В работе</option><option value="attention">Требуют внимания</option><option value="overdue">Просрочены</option><option value="closed">Закрыты</option>
				</select>
				<select value={inventoryStore} onChange={(event) => setInventoryStore(event.target.value)} aria-label="Точка">
					<option value="all">Все точки</option>{stores.map((store) => <option key={store.id} value={store.id}>{store.title}</option>)}
				</select>
				<input type="search" value={inventorySearch} onChange={(event) => setInventorySearch(event.target.value)} placeholder="Поиск по №, точке или ответственному" aria-label="Поиск" />
				<select value={inventorySort} onChange={(event) => setInventorySort(event.target.value as InventorySort)} aria-label="Сортировка">
					<option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="deadline">По ближайшему сроку</option><option value="discrepancies">По расхождениям</option>
				</select>
				<button type="button" className="inventory-reset" onClick={() => { setInventoryStatus('all'); setInventoryStore('all'); setInventorySearch(''); setInventorySort('newest'); }}>Сбросить</button>
			</section>

			<div className="inventory-list-toolbar">
				<div><strong>Список инвентаризаций</strong><span>Показано {filteredInventories.length} из {availableInventories.length}</span></div>
				<div><span>{lastUpdatedAt ? `Обновлено ${new Date(lastUpdatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}` : 'Данные загружаются'}</span><button type="button" disabled={reloading} onClick={() => void reload()} title="Обновить список">{reloading ? '…' : '↻'}</button></div>
			</div>

			{filteredInventories.length ? <>
				<div className="inventory-registry-table-wrap">
					<table className="inventory-registry-table">
						<thead><tr><th aria-label="Раскрытие"></th><th>№ / дата</th><th>Статус</th><th>Точки</th><th>Прогресс</th><th>Расхождения</th><th>Срок</th><th>Действия</th></tr></thead>
						<tbody>{filteredInventories.map((inv) => {
							const progress = inventoryProgress(inv);
							const deadlineState = inventoryDeadlineStatus(inv);
							const opened = expandedInventory === inv.id;
							return <Fragment key={inv.id}>
								<tr className={`inventory-main-row${opened ? ' open' : ''}`} onClick={() => setExpandedInventory(opened ? null : inv.id)}>
									<td><span className="inventory-chevron" aria-hidden="true">{opened ? '▾' : '▸'}</span></td>
									<td><strong className="inventory-id">№ {inv.id}</strong><span>{inventoryCreatedLabel(inv.createdAt)}</span></td>
									<td><span className={`inventory-pill ${inv.status === 'closed' ? 'gray' : 'blue'}`}>{inv.status === 'closed' ? 'Закрыта' : 'В работе'}</span>{inventoryNeedsAttention(inv) && <span className="inventory-row-note attention">Требует внимания</span>}</td>
									<td><strong>{inv.points[0]?.storeName ?? 'Без точек'}</strong><span>{inv.points.length > 1 ? `и ещё ${inv.points.length - 1}` : `${inv.points.length} точка`}</span></td>
									<td><div className="inventory-progress-label"><strong>{progress.done} / {progress.total}</strong><span>сверено</span></div><div className="inventory-progress"><i style={{ width: `${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%` }} /></div>{progress.started > progress.done && <span>{progress.started - progress.done} в процессе</span>}</td>
									<td>{progress.discrepancies ? <span className="inventory-pill red">{progress.discrepancies} поз.</span> : progress.started ? <span className="inventory-pill green">Без расхождений</span> : <span className="inventory-muted">—</span>}</td>
									<td>{inv.status === 'closed' ? <span className="inventory-muted">—</span> : deadlineState ? <span className={`deadline ${deadlineState.cls}`}>{deadlineState.text}</span> : <span className="inventory-muted">Без срока</span>}</td>
									<td><button className="inventory-expand" type="button" aria-expanded={opened} onClick={(event) => { event.stopPropagation(); setExpandedInventory(opened ? null : inv.id); }}>{opened ? 'Скрыть' : 'Открыть'}</button></td>
								</tr>
								{opened && <tr className="inventory-details-row"><td colSpan={8}>{inventoryDetails(inv)}</td></tr>}
							</Fragment>;
						})}</tbody>
					</table>
				</div>
				<div className="inventory-mobile-list">{filteredInventories.map((inv) => {
					const progress = inventoryProgress(inv);
					const opened = expandedInventory === inv.id;
					const deadlineState = inventoryDeadlineStatus(inv);
					return <article className="inventory-mobile-card" key={inv.id}>
						<div className="inventory-mobile-head"><strong className="inventory-id">№ {inv.id}</strong><span className={`inventory-pill ${inv.status === 'closed' ? 'gray' : 'blue'}`}>{inv.status === 'closed' ? 'Закрыта' : 'В работе'}</span></div>
						<strong>{inv.points[0]?.storeName ?? 'Без точек'}{inv.points.length > 1 ? ` +${inv.points.length - 1}` : ''}</strong>
						<div className="inventory-mobile-meta"><span>Сверено {progress.done}/{progress.total}</span><span>{progress.discrepancies ? `Расхождений ${progress.discrepancies}` : 'Расхождений нет'}</span>{inv.status !== 'closed' && <span>{deadlineState?.text ?? 'Без срока'}</span>}</div>
						<button className="inventory-expand" type="button" onClick={() => setExpandedInventory(opened ? null : inv.id)}>{opened ? 'Скрыть точки' : 'Открыть точки'}</button>
						{opened && inventoryDetails(inv)}
					</article>;
				})}</div>
			</> : <p className="inventory-empty">{availableInventories.length ? 'По заданным условиям ничего не найдено.' : isInitiator ? 'Пока ни одной инвентаризации. Создайте первую.' : 'Сейчас нет активных инвентаризаций. Можно создать новую.'}</p>}
			{qrFor && <QrModal invId={qrFor.invId} storeId={qrFor.storeId} storeName={qrFor.storeName} onClose={() => setQrFor(null)} />}
			{erpFor && (
				<ErpDocModal
					invId={erpFor.invId}
					storeId={erpFor.storeId}
					storeName={erpFor.storeName}
					mock={Boolean(ctx.__mock)}
					onClose={() => setErpFor(null)}
					onChanged={() => void reload()}
				/>
			)}
		</div>
	);
}

/**
 * По сверенной точке создаются независимые черновики ядра: Material Issue для
 * недостачи и Material Receipt для излишков. Проведение можно безопасно повторить:
 * уже проведённый документ будет пропущен, а незавершённый продолжен.
 */
function ErpDocModal(props: {
	invId: string;
	storeId: number;
	storeName: string;
	mock: boolean;
	onClose: () => void;
	onChanged: () => void;
}): JSX.Element {
	const [lines, setLines] = useState<ErpRecoLine[] | null>(null);
	const [docs, setDocs] = useState<ErpInvDocuments>({});
	const [legacyDoc, setLegacyDoc] = useState<ErpInvDoc | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	function applyDocumentState(state: ErpInvDocumentState): void {
		setDocs(state.docs);
		setLegacyDoc(state.legacyDoc);
	}

	async function refreshDocumentState(): Promise<void> {
		const result = await withTimeout(previewErpDoc(props.invId, props.storeId), 20000, 'erp-doc-preview');
		setLines(result.lines);
		applyDocumentState(result);
	}

	useEffect(() => {
		if (props.mock) { setLines([]); setErr('dev-мок: документ ядра доступен только с подключённым ERPNext.'); return; }
		let alive = true;
		withTimeout(previewErpDoc(props.invId, props.storeId), 20000, 'erp-doc-preview')
			.then((result) => { if (alive) { setLines(result.lines); setDocs(result.docs); setLegacyDoc(result.legacyDoc); } })
			.catch((e: unknown) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
		return () => { alive = false; };
	}, [props.invId, props.storeId, props.mock]);

	async function doConduct(): Promise<void> {
		if (!window.confirm('Провести инвентаризацию? Недостача спишется, излишек оприходуется в ERPNext.')) return;
		setBusy(true); setErr(null);
		try {
			// Перед проведением перечитываем состояние: это исключает работу по устаревшему меню.
			let state = await withTimeout(previewErpDoc(props.invId, props.storeId), 20000, 'erp-doc-preview');
			setLines(state.lines);
			applyDocumentState(state);
			const stateDocuments = Object.values(state.docs);
			const stateSubmitted = stateDocuments.length > 0
				? stateDocuments.every((document) => document.status === 'submitted')
				: state.legacyDoc?.status === 'submitted';
			if (stateSubmitted) { props.onChanged(); return; }
			if (!stateDocuments.length && !state.legacyDoc) {
				state = { ...state, ...await withTimeout(saveErpDoc(props.invId, props.storeId), 25000, 'erp-doc-save') };
				applyDocumentState(state);
			}
			const submittedState = await withTimeout(submitErpDoc(props.invId, props.storeId), 55000, 'erp-doc-submit');
			applyDocumentState(submittedState);
			props.onChanged();
		} catch (e: unknown) {
			const msg = String(e instanceof Error ? e.message : e);
			setErr(msg.includes('таймаут') ? `${msg} — нажми «Провести документы» ещё раз: продолжу с места обрыва, дублей не будет` : msg);
			await refreshDocumentState().catch(() => undefined);
		}
		finally { setBusy(false); }
	}

	const documentList = Object.entries(docs) as Array<['issue' | 'receipt', ErpInvDoc]>;
	const submitted = documentList.length > 0
		? documentList.every(([, document]) => document.status === 'submitted')
		: legacyDoc?.status === 'submitted';
	return (
		<div className="qr-overlay" onClick={props.onClose}>
			<div className="qr-modal erp-doc-modal" onClick={(e) => e.stopPropagation()}>
				<div className="qr-head">
					<strong>Проведение инвентаризации — {props.storeName}</strong>
					<button className="btn-del" title="Закрыть" onClick={props.onClose}>✕</button>
				</div>
				{legacyDoc ? (
					<p className="muted">
						Старый документ сверки: {legacyDoc.status === 'submitted' ? `✓ ${legacyDoc.name} проведён` : `✎ черновик ${legacyDoc.name}`} · строк {legacyDoc.lines}
					</p>
				) : documentList.length ? (
					<div className="inventory-document-list">
						{documentList.map(([kind, document]) => (
							<p className="muted" key={kind}>
								{document.status === 'submitted' ? '✓' : '✎'} {kind === 'issue' ? 'Списание недостачи' : 'Оприходование излишков'}: <b>{document.name}</b> · строк {document.lines} · {document.status === 'submitted' ? 'проведён' : 'черновик, остатки не тронуты'}
							</p>
						))}
					</div>
				) : (
					<p className="muted">Документы ещё не записаны. Будут созданы отдельно: списание недостачи и оприходование излишков.</p>
				)}
				{err && <p className="error">⛔ {err}</p>}
				{lines === null && !err ? <p>Считаю болванку…</p> : null}
				{lines !== null && !submitted && (
					lines.length ? (
						<table className="disc-table">
							<thead>
								<tr><th>Товар</th><th className="num">Учёт ядра</th><th className="num">Факт</th><th className="num">Разница</th></tr>
							</thead>
							<tbody>
								{lines.map((l) => (
									<tr key={l.productId}>
										<td>{l.name}</td>
										<td className="num">{l.bookErp}</td>
										<td className="num">{l.fact}</td>
										<td className={`num ${l.diff < 0 ? 'short' : 'over'}`}>{l.diff > 0 ? `+${l.diff}` : l.diff}</td>
									</tr>
								))}
							</tbody>
						</table>
					) : !err ? <p className="muted">Факты сошлись с ядром — документ не нужен.</p> : null
				)}
				<div className="inv-actions">
					{lines !== null && lines.length > 0 && !submitted && <button className="btn-primary" disabled={busy} onClick={() => void doConduct()}>{busy ? 'Провожу…' : 'Провести документы'}</button>}
					{submitted && <span className="hint ok">Инвентаризация проведена, остатки обновлены.</span>}
					<button className="btn-secondary" onClick={props.onClose}>Закрыть</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Модалка с QR точки: телефон сканирует → /m?inv&store → подсчёт этого склада.
 * URL строим от origin нашего приложения (контейнер), где живёт роут /m — НЕ от портала.
 */
function QrModal({ invId, storeId, storeName, onClose }: { invId: string; storeId: number; storeName: string; onClose: () => void }): JSX.Element {
	const url = `${window.location.origin}/m?inv=${encodeURIComponent(invId)}&store=${storeId}`;
	const [dataUrl, setDataUrl] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		QRCode.toDataURL(url, { width: 280, margin: 1 })
			.then((d) => { if (alive) setDataUrl(d); })
			.catch((e: unknown) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
		return () => { alive = false; };
	}, [url]);
	return (
		<div className="qr-overlay" onClick={onClose}>
			<div className="qr-modal" onClick={(e) => e.stopPropagation()}>
				<div className="qr-head">
					<strong>📱 {storeName}</strong>
					<button className="btn-del" title="Закрыть" onClick={onClose}>✕</button>
				</div>
				<p className="muted">Отсканируйте телефоном — откроется подсчёт этой точки. Войдёте под своей учёткой Б24.</p>
				{err ? <p className="error">⛔ {err}</p> : dataUrl ? <img className="qr-img" src={dataUrl} alt="QR-код точки" /> : <p>Генерация QR…</p>}
				<code className="qr-url">{url}</code>
			</div>
		</div>
	);
}

/** Детали отчёта точки: посчитано N/M + список расхождений (учёт/факт/разница). */
const inventoryRubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 2 });

function InventoryMoneySummary({ results, label, partial = false }: { results: InvResult[]; label: string; partial?: boolean }): JSX.Element {
	const money = inventoryMoney(results);
	const displayMoney = (value: number): string => money.missingPrice > 0 && money.valuedCount === 0 ? '—' : inventoryRubles.format(value);
	return <section className="inventory-money-summary" aria-label={label}>
		<div className="inventory-money-grid">
			<div className="inventory-money-card surplus"><span>Излишки</span><strong>{displayMoney(money.surplus)}</strong></div>
			<div className="inventory-money-card shortage"><span>Недостача</span><strong>{displayMoney(money.shortage)}</strong></div>
			<div className="inventory-money-card total"><span>Итого: излишки − недостача</span><strong>{money.net > 0 ? '+' : ''}{displayMoney(money.net)}</strong></div>
		</div>
		<div className="inventory-money-note">
			<span>По закупочной цене на момент отправки отчёта.{partial ? ' Подсчёт завершён не на всех точках.' : ''}{money.missingPrice ? ` ${money.missingPrice} поз. без закупочной цены не включены в суммы.` : ''}</span>
		</div>
	</section>;
}

function DiscDetail({ result }: { result: InvResult }): JSX.Element {
	const unfilled = result.unfilled ?? result.lines.filter((line) => line.unfilled).length;
	return (
		<div className="disc-detail">
			<div className="disc-head">
				Посчитано {result.counted}/{result.total}
				{unfilled > 0 ? ` · не заполнено ${unfilled} (принято за 0)` : ''} · расхождений {result.discrepancies}
			</div>
			<InventoryMoneySummary results={[result]} label="Итоги по точке" />
			{result.lines.length ? (
				<table className="disc-table">
					<thead>
						<tr>
							<th>Товар</th>
							<th className="num">Учёт</th>
							<th className="num">Факт</th>
							<th className="num">Разница</th>
							<th className="num">Закупка</th>
							<th className="num">Сумма</th>
							<th>Заполнение</th>
							<th>Комментарий</th>
						</tr>
					</thead>
					<tbody>
						{result.lines.map((l) => (
							<tr key={l.productId}>
								<td>{l.name}</td>
								<td className="num">{l.book}</td>
								<td className="num">{l.fact}</td>
								<td className={`num ${l.diff < 0 ? 'short' : 'over'}`}>{l.diff > 0 ? `+${l.diff}` : l.diff}</td>
								<td className="num">{Number.isFinite(l.purchase) ? `${Number(l.purchase).toLocaleString('ru-RU')} ₽` : '—'}</td>
								<td className={`num ${l.diff < 0 ? 'short' : 'over'}`}>{Number.isFinite(l.purchase) && Number(l.purchase) >= 0 ? `${l.diff > 0 ? '+' : '−'}${inventoryRubles.format(Math.abs(l.diff) * Number(l.purchase))}` : '—'}</td>
								<td>{l.unfilled ? 'Не заполнено — принято за 0' : 'Заполнено'}</td>
								<td className="disc-comment">{l.comment || '—'}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : (
				<p className="muted">Расхождений нет — факт сошёлся с учётом.</p>
			)}
		</div>
	);
}

/** Поисковый мультивыбор (чекбоксы со скроллом). Для охвата-разделов и списка оповещаемых. */
function MultiPick(props: {
	options: { id: string; label: string }[];
	selected: string[];
	onChange: (ids: string[]) => void;
	placeholder: string;
	empty: string;
}): JSX.Element {
	const { options, selected, onChange, placeholder, empty } = props;
	const [q, setQ] = useState('');
	const sel = new Set(selected);
	const ql = q.trim().toLowerCase();
	const shown = ql ? options.filter((o) => o.label.toLowerCase().includes(ql)) : options;
	function toggle(id: string): void {
		const next = new Set(sel);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onChange([...next]);
	}
	if (!options.length) return <p className="muted small">{empty}</p>;
	return (
		<div className="multi-pick">
			<input className="inv-input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
			<div className="multi-toolbar">
				<button type="button" className="link-btn" onClick={() => onChange(options.map((o) => o.id))}>Выбрать все</button>
				<button type="button" className="link-btn" onClick={() => onChange([])}>Снять все</button>
				{selected.length > 0 && <span className="multi-count">выбрано: {selected.length}</span>}
			</div>
			<div className="multi-list">
				{shown.map((o) => (
					<label className="multi-item" key={o.id}>
						<input type="checkbox" checked={sel.has(o.id)} onChange={() => toggle(o.id)} /> {o.label}
					</label>
				))}
				{!shown.length && <p className="muted small">Ничего не найдено.</p>}
			</div>
		</div>
	);
}

/** Тег-инпут с автокомплитом: набираешь → выбираешь из совпадений → чип-хэштег; «×» убирает. Компактно. */
function TagPicker(props: {
	options: { id: string; label: string }[];
	selected: string[];
	onChange: (ids: string[]) => void;
	placeholder: string;
	empty: string;
}): JSX.Element {
	const { options, selected, onChange, placeholder, empty } = props;
	const [q, setQ] = useState('');
	const sel = new Set(selected);
	const byId = new Map(options.map((o) => [o.id, o.label]));
	const ql = q.trim().toLowerCase();
	const matches = ql ? options.filter((o) => !sel.has(o.id) && o.label.toLowerCase().includes(ql)).slice(0, 8) : [];
	function add(id: string): void {
		if (sel.has(id)) return;
		onChange([...selected, id]);
		setQ('');
	}
	function remove(id: string): void {
		onChange(selected.filter((x) => x !== id));
	}
	if (!options.length) return <p className="muted small">{empty}</p>;
	return (
		<div className="tag-pick">
			{selected.length > 0 && (
				<div className="tag-chips">
					{selected.map((id) => (
						<span className="tag-chip" key={id}>
							{byId.get(id) ?? id}
							<button type="button" className="tag-x" onClick={() => remove(id)} aria-label="убрать">×</button>
						</span>
					))}
				</div>
			)}
			<div className="tag-input-wrap">
				<input
					className="inv-input"
					placeholder={placeholder}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							const first = matches[0];
							if (first) {
								e.preventDefault();
								add(first.id);
							}
						}
					}}
				/>
				{matches.length > 0 && (
					<div className="tag-dropdown">
						{matches.map((o) => (
							<button type="button" className="tag-option" key={o.id} onMouseDown={(e) => { e.preventDefault(); add(o.id); }}>
								{o.label}
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

function Shell({ children }: { children: JSX.Element }): JSX.Element {
	return <div className="inv"><header><h1>Инвентаризация</h1></header><section>{children}</section></div>;
}
