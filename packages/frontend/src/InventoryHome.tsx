import { useEffect, useState } from 'react';
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
	makeActPoint,
	reopenPoint,
	buildPointDocuments,
	getInitiators,
	fetchCurrentUser,
	isPortalAdmin,
	withTimeout,
	previewErpDoc,
	saveErpDoc,
	submitErpDoc,
	type ErpInvDoc,
	type ErpRecoLine,
	type Inventory,
	type InvPoint,
	type BuiltDoc,
	type InvResult,
	type SimpleUser,
	type StoreInfo,
} from './b24.js';
import { InventoryCount } from './InventoryReport.js';

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
function deadlineStatus(deadline: string): { text: string; cls: string } | null {
	if (!deadline) return null;
	const dd = new Date(`${deadline}T00:00:00`);
	if (Number.isNaN(dd.getTime())) return null;
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const days = Math.round((dd.getTime() - today.getTime()) / 86400000);
	if (days < 0) return { text: '🔴 просрочено', cls: 'overdue' };
	if (days === 0) return { text: '⚠️ срок сегодня', cls: 'soon' };
	if (days === 1) return { text: '⚠️ остался 1 день', cls: 'soon' };
	return { text: `до ${dd.toLocaleDateString('ru-RU')}`, cls: 'ok' };
}

/** Текст и значок статуса точки для сводки. */
function pointState(p: InvPoint): { dot: string; text: string } {
	const st = p.status ?? 'idle';
	const who = p.responsibleName ? ` · ${p.responsibleName}` : '';
	const disc = p.result ? ` · расхождений ${p.result.discrepancies}` : '';
	if (st === 'reconciled') return { dot: '✅', text: `сверено${who}${disc}` };
	if (st === 'act') return { dot: '📝', text: `акт на сверке${who}` };
	if (st === 'submitted') return { dot: '🟢', text: `отправлено${who}${disc}` };
	if (st === 'in_progress') return { dot: '🔵', text: `в работе${who}` };
	return { dot: '⚪', text: p.responsibleName ? `назначен: ${p.responsibleName}` : 'не начато' };
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

	const [counting, setCounting] = useState<Counting | null>(null);
	const [actionErr, setActionErr] = useState<string | null>(null);
	/** Ключ `invId:storeId` раскрытой точки (просмотр расхождений). */
	const [expanded, setExpanded] = useState<string | null>(null);
	/** Результат формирования документов: текст + ссылки на черновики (кнопки «Открыть»). */
	const [docResult, setDocResult] = useState<{ docs: BuiltDoc[]; text: string } | null>(null);
	/** Открытая модалка QR точки (мобильный подсчёт): какую точку показываем. */
	const [qrFor, setQrFor] = useState<{ invId: string; storeId: number; storeName: string } | null>(null);
	/** Открытая модалка документа ЯДРА (Stock Reconciliation, 1С-цепочка Записать→Провести). */
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
					id: '1',
					title: 'Инвентаризация Июнь',
					status: 'active',
					deadline: '2026-06-05',
					createdById: '1',
					createdAt: '2026-06-01',
					points: [
						{ storeId: 8, storeName: 'Максидом Дунайский 64', responsibleId: '18', responsibleName: 'Иванов Иван', status: 'in_progress', startedAt: '2026-06-01' },
						{ storeId: 10, storeName: 'Максидом Богатырский 15', responsibleId: '', responsibleName: '', status: 'idle' },
						{
							storeId: 22, storeName: 'Максидом Фаворского 12', responsibleId: '34', responsibleName: 'Петров Пётр', status: 'reconciled',
							submittedAt: '2026-06-02',
							result: { counted: 41, total: 42, discrepancies: 2, lines: [
								{ productId: 1924, name: 'IP камера купольная', book: 18, fact: 16, diff: -2 },
								{ productId: 2050, name: 'Кабель UTP 5E (бухта)', book: 7, fact: 8, diff: 1 },
							] },
							draft: { 1924: 16, 2050: 8 },
						},
					],
				},
			]);
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
				// роль инициатора — ниже (админ ИЛИ в списке инициаторов)
					const init = isPortalAdmin() || initiators.includes(uid);
				setIsInitiator(init);

				const sts = await withTimeout(fetchStores(), 15000, 'catalog.store.list');
				const usrs = init ? await withTimeout(fetchUsers(), 15000, 'user.get').catch(() => [] as SimpleUser[]) : [];
				const secs = init ? await withTimeout(fetchSections(), 15000, 'catalog.section.list').catch(() => [] as { id: number; name: string }[]) : [];
				setMe(meUser);
				setStores(sts.filter((s) => s.active));
				setUsers(usrs);
				setSections(secs);
				setPhase({ k: 'ready' });

				void (async () => {
					try {
						setInventories(await withTimeout(listInventories(), 20000, 'entity.item.get'));
					} catch (e: unknown) {
						setStorageWarn(`${String(e instanceof Error ? e.message : e)} (если хранилище не создано — пусть Володя/админ откроет приложение)`);
					}
				})();
			})().catch((e: unknown) => setPhase({ k: 'error', msg: String(e instanceof Error ? e.message : e) }));
		});
	}, [ctx]);

	async function reload(): Promise<void> {
		if (ctx.__mock) return;
		try {
			setInventories(await withTimeout(listInventories(), 20000, 'list'));
		} catch {
			/* оставляем текущий список */
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

	/** «Сформировать акт разногласий» (инициатор) — отправленная точка уходит менеджеру на сверку. */
	async function makeAct(inv: Inventory, p: InvPoint): Promise<void> {
		setActionErr(null);
		if (ctx.__mock) {
			markPoint(inv.id, p.storeId, { status: 'act', actAt: new Date().toISOString() });
			return;
		}
		try {
			await withTimeout(makeActPoint(inv.id, p.storeId, me.id), 12000, 'makeAct');
			markPoint(inv.id, p.storeId, { status: 'act' });
		} catch (e: unknown) {
			setActionErr(String(e instanceof Error ? e.message : e));
		}
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

	/** Открыть карточку складского документа в Б24 (слайдером, не уходя из приложения). */
	function openDoc(id: number): void {
		const path = `/shop/documents/details/${id}/?inventoryManagementSource=inventory`;
		const bx = window.BX24;
		if (bx && typeof bx.openPath === 'function') bx.openPath(path);
		else {
			const auth = bx ? bx.getAuth() : false;
			window.open(`https://${auth ? (auth.domain ?? '') : ''}${path}`, '_blank');
		}
	}

	/** Сформировать черновики списания/оприходования по сверённой точке (фаза C). Проведение — вручную в Б24. */
	async function buildDocs(inv: Inventory, p: InvPoint): Promise<void> {
		setActionErr(null);
		setDocResult(null);
		if (ctx.__mock) {
			setDocResult({ docs: [], text: 'dev-мок: документы формируются только на проде.' });
			return;
		}
		if (!window.confirm(`Сформировать ЧЕРНОВИКИ списания/оприходования по точке «${p.storeName}»? Остатки не изменятся — проводить будешь сам в Б24.`)) return;
		try {
			const { docs, message } = await withTimeout(buildPointDocuments(inv.id, p.storeId, me.id), 20000, 'build-documents');
			setDocResult({ docs, text: message ?? 'Черновики созданы (не проведены). Открой, проверь и проведи в Б24:' });
			void reload();
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
		if (st === 'submitted') {
			return (
				<>
					{isInitiator && <button className="btn-mini" onClick={() => void makeAct(inv, p)}>Сформировать акт</button>}
					{openBtn}
					{reopenBtn}
				</>
			);
		}
		if (st === 'act') {
			return (
				<>
					<button className="btn-mini" onClick={() => continuePoint(inv, p, 'act')}>Проверить акт</button>
					{openBtn}
					{reopenBtn}
				</>
			);
		}
		if (st === 'reconciled') {
			const erpBadge = p.erpDoc ? (p.erpDoc.status === 'submitted' ? ' ✓' : ' ✎') : '';
			return (
				<>
					{isInitiator && (
						<button className="btn-mini" onClick={() => setErpFor({ invId: inv.id, storeId: p.storeId, storeName: p.storeName })}>
							Документ ядра{erpBadge}
						</button>
					)}
					{isInitiator && !p.erpDoc && <button className="btn-mini ghost" onClick={() => void buildDocs(inv, p)}>Документы в Б24</button>}
					{openBtn}
					{reopenBtn}
				</>
			);
		}
		return null;
	};

	const invCard = (inv: Inventory): JSX.Element => {
		const ds = deadlineStatus(inv.deadline);
		return (
			<div className="inv-card" key={inv.id}>
				<div className="inv-card-head">
					<strong>{inv.title}</strong>
					<span className={`badge ${inv.status}`}>{inv.status === 'active' ? 'активна' : inv.status}</span>
					{ds && <span className={`deadline ${ds.cls}`}>{ds.text}</span>}
					{isInitiator && (
						<button className="btn-del" title="Удалить инвентаризацию" onClick={() => void removeInventory(inv)}>
							✕
						</button>
					)}
				</div>
				<ul className="point-list">
					{inv.points.map((p) => {
						const s = pointState(p);
						const key = `${inv.id}:${p.storeId}`;
						return (
							<li className="point-line-wrap" key={p.storeId}>
								<div className="point-line">
									<span className="point-name">{p.storeName}</span>
									<span className="point-state">
										{s.dot} {s.text}
									</span>
									{pointAction(inv, p)}
									<button
										className="btn-mini ghost qr-btn"
										title="QR для подсчёта с телефона"
										onClick={() => setQrFor({ invId: inv.id, storeId: p.storeId, storeName: p.storeName })}
									>
										📱 QR
									</button>
								</div>
								{expanded === key && p.result && <DiscDetail result={p.result} />}
							</li>
						);
					})}
				</ul>
			</div>
		);
	};

	const activeInvs = inventories.filter((inv) => inv.status === 'active');

	// Менеджер (не инициатор): активные инвентаризации, берёт свободную/свою точку
	if (!isInitiator) {
		return (
			<div className="inv">
				<header>
					<h1>Инвентаризация</h1>
					<p className="subtitle">{me.name} · возьмите точку, где вы сейчас работаете</p>
				</header>
				{actionErr && <div className="beta-banner">⛔ {actionErr}</div>}
				{activeInvs.length ? activeInvs.map(invCard) : <p className="stub-calm">Сейчас нет активных инвентаризаций.</p>}
				{qrFor && <QrModal invId={qrFor.invId} storeId={qrFor.storeId} storeName={qrFor.storeName} onClose={() => setQrFor(null)} />}
			</div>
		);
	}

	// Инициатор: создание + сводка статусов (и сам может пройти точку)
	return (
		<div className="inv">
			<header>
				<h1>Инвентаризация</h1>
				<p className="subtitle">{me.name} · инициатор{ctx.__mock ? ' · dev-мок' : ''}</p>
			</header>

			{!creating && (
				<div className="inv-actions"><button className="btn-primary" onClick={() => setCreating(true)}>+ Создать инвентаризацию</button></div>
			)}

			{creating && (
				<div className="inv-card create">
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
			{docResult && (
					<div className="beta-banner ok">
						✅ {docResult.text}
						{docResult.docs.map((d) => (
							<button key={d.id} className="btn-mini doc-open" onClick={() => openDoc(d.id)}>
								Открыть {d.type === 'D' ? 'списание' : 'оприходование'} #{d.id}
							</button>
						))}
					</div>
				)}
				{storageWarn && <div className="beta-banner">⚠️ Хранилище не отвечает: {storageWarn}. Список может быть пуст, а создание — не сохраниться. Похоже, упёрлись в entity-хранилище — напиши мне, добью.</div>}
			<h2 className="inv-h2">Инвентаризации</h2>
			{inventories.length ? inventories.map(invCard) : <p className="stub-calm">Пока ни одной инвентаризации. Создайте первую.</p>}
			{qrFor && <QrModal invId={qrFor.invId} storeId={qrFor.storeId} storeName={qrFor.storeName} onClose={() => setQrFor(null)} />}
			{erpFor && (
				<ErpDocModal
					invId={erpFor.invId}
					storeId={erpFor.storeId}
					storeName={erpFor.storeName}
					userId={me.id}
					mock={Boolean(ctx.__mock)}
					openDoc={openDoc}
					onClose={() => setErpFor(null)}
					onChanged={() => void reload()}
				/>
			)}
		</div>
	);
}

/**
 * Документ ЯДРА «на основании» точки (1С-модель): болванка (ничего не записано;
 * закрыл — пропала) → «Записать» (черновик Stock Reconciliation в ERPNext) →
 * «Провести» (остатки ядра двигаются + в Б24 создаются ЧЕРНОВИКИ-зеркала D/S).
 * Книга здесь — остатки ЯДРА (ERPNext), не Б24: документ выравнивает ядро по фактам.
 */
function ErpDocModal(props: {
	invId: string;
	storeId: number;
	storeName: string;
	userId: string;
	mock: boolean;
	openDoc: (id: number) => void;
	onClose: () => void;
	onChanged: () => void;
}): JSX.Element {
	const [lines, setLines] = useState<ErpRecoLine[] | null>(null);
	const [doc, setDoc] = useState<ErpInvDoc | null>(null);
	const [mirrors, setMirrors] = useState<BuiltDoc[]>([]);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	useEffect(() => {
		if (props.mock) { setLines([]); setErr('dev-мок: документ ядра доступен только с подключённым ERPNext.'); return; }
		let alive = true;
		withTimeout(previewErpDoc(props.invId, props.storeId), 20000, 'erp-doc-preview')
			.then((r) => { if (alive) { setLines(r.lines); setDoc(r.doc); setMirrors(r.docs); } })
			.catch((e: unknown) => { if (alive) setErr(String(e instanceof Error ? e.message : e)); });
		return () => { alive = false; };
	}, [props.invId, props.storeId, props.mock]);

	async function doSave(recreate = false): Promise<void> {
		setBusy(true); setErr(null);
		try {
			const d = await withTimeout(saveErpDoc(props.invId, props.storeId, recreate), 25000, 'erp-doc-save');
			setDoc(d);
			props.onChanged();
		} catch (e: unknown) { setErr(String(e instanceof Error ? e.message : e)); }
		finally { setBusy(false); }
	}

	async function doSubmit(): Promise<void> {
		if (!doc) return;
		// дозавершение уже проведённого (зеркала после таймаута) — без устрашающего confirm
		if (doc.status !== 'submitted' && !window.confirm(`Провести ${doc.name} в ядре? Остатки ERPNext изменятся по фактам точки, в Б24 будут созданы ЧЕРНОВИКИ-зеркала (их проводишь сам).`)) return;
		setBusy(true); setErr(null);
		try {
			// проведение в ядре + зеркала идут через мост и могут быть небыстрыми; serverless-кап 60с
			const r = await withTimeout(submitErpDoc(props.invId, props.storeId, props.userId), 55000, 'erp-doc-submit');
			setDoc(r.doc);
			setMirrors(r.docs);
			props.onChanged();
		} catch (e: unknown) {
			const msg = String(e instanceof Error ? e.message : e);
			setErr(msg.includes('таймаут') ? `${msg} — нажми «Провести» ещё раз: продолжу с места обрыва, дублей не будет` : msg);
		}
		finally { setBusy(false); }
	}

	const submitted = doc?.status === 'submitted';
	return (
		<div className="qr-overlay" onClick={props.onClose}>
			<div className="qr-modal erp-doc-modal" onClick={(e) => e.stopPropagation()}>
				<div className="qr-head">
					<strong>🧠 Документ ядра — {props.storeName}</strong>
					<button className="btn-del" title="Закрыть" onClick={props.onClose}>✕</button>
				</div>
				{doc ? (
					<p className="muted">
						{submitted ? `✓ ${doc.name} ПРОВЕДЁН в ядре` : `✎ черновик ${doc.name} записан (остатки не тронуты)`} · строк {doc.lines}
					</p>
				) : (
					<p className="muted">Болванка «на основании» точки: ничего не записано — закроешь, и она пропала. Учёт здесь — остатки ЯДРА.</p>
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
				{submitted && mirrors.length > 0 && (
					<div className="beta-banner ok">
						Зеркала в Б24 (черновики — проверь и проведи сам):
						{mirrors.map((d) => (
							<button key={d.id} className="btn-mini doc-open" onClick={() => props.openDoc(d.id)}>
								Открыть {d.type === 'D' ? 'списание' : 'оприходование'} #{d.id}
							</button>
						))}
					</div>
				)}
				<div className="inv-actions">
					{!doc && lines !== null && lines.length > 0 && (
						<button className="btn-primary" disabled={busy} onClick={() => void doSave()}>{busy ? 'Записываю…' : 'Записать'}</button>
					)}
					{doc && !submitted && (
						<>
							<button className="btn-primary" disabled={busy} onClick={() => void doSubmit()}>{busy ? 'Провожу…' : 'Провести'}</button>
							<button className="btn-secondary" disabled={busy} onClick={() => void doSave(true)}>Пересоздать от свежей болванки</button>
						</>
					)}
					{submitted && mirrors.length === 0 && (
						<button className="btn-primary" disabled={busy} onClick={() => void doSubmit()}>{busy ? 'Дозавершаю…' : 'Дозавершить зеркала в Б24'}</button>
					)}
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
function DiscDetail({ result }: { result: InvResult }): JSX.Element {
	return (
		<div className="disc-detail">
			<div className="disc-head">
				Посчитано {result.counted}/{result.total}
				{result.total - result.counted > 0 ? ` · не введено ${result.total - result.counted}` : ''} · расхождений {result.discrepancies}
			</div>
			{result.lines.length ? (
				<table className="disc-table">
					<thead>
						<tr>
							<th>Товар</th>
							<th className="num">Учёт</th>
							<th className="num">Факт</th>
							<th className="num">Разница</th>
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
