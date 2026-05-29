import { useEffect, useState } from 'react';
import { getContext, type B24Context } from './b24-context.js';
import {
	fetchStores,
	fetchUsers,
	listInventories,
	createInventory,
	getInitiators,
	fetchCurrentUserId,
	withTimeout,
	BETA_USER_IDS,
	type Inventory,
	type InvPoint,
	type SimpleUser,
	type StoreInfo,
} from './b24.js';

/**
 * Модуль инвентаризации (вход из левого меню). Своя сущность, без привязки к задаче.
 * v1: инициатор создаёт инвентаризацию (точки + ответственные) и видит список.
 * v2 (дальше): менеджер открывает свою точку → считает → отправляет; живая сводка статусов.
 *
 * Канарейка: модуль виден только бета-юзеру (Сергей 1858). Бета = инициатор (для теста).
 */

type Phase = { k: 'init' } | { k: 'denied' } | { k: 'error'; msg: string } | { k: 'ready' };

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

export function InventoryHome(): JSX.Element {
	const [ctx] = useState<B24Context>(() => getContext());
	const [phase, setPhase] = useState<Phase>({ k: 'init' });
	const [me, setMe] = useState<SimpleUser>({ id: '', name: '' });
	const [isInitiator, setIsInitiator] = useState(false);
	const [inventories, setInventories] = useState<Inventory[]>([]);
	const [stores, setStores] = useState<StoreInfo[]>([]);
	const [users, setUsers] = useState<SimpleUser[]>([]);

	const [creating, setCreating] = useState(false);
	const [title, setTitle] = useState('');
	const [picked, setPicked] = useState<Record<number, string>>({});
	const [saving, setSaving] = useState(false);
	const [storageWarn, setStorageWarn] = useState<string | null>(null);

	useEffect(() => {
		if (ctx.__mock) {
			setMe({ id: '1858', name: 'Сергей Ласкин (dev)' });
			setIsInitiator(true);
			setStores(MOCK_STORES);
			setUsers(MOCK_USERS);
			setInventories([
				{ id: '1', title: 'Инвентаризация Июнь', status: 'active', createdById: '1', createdAt: '2026-06-01', points: [
					{ storeId: 8, storeName: 'Максидом Дунайский 64', responsibleId: '18', responsibleName: 'Иванов Иван' },
					{ storeId: 10, storeName: 'Максидом Богатырский 15', responsibleId: '34', responsibleName: 'Петров Пётр' },
				] },
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
				const uid = await withTimeout(fetchCurrentUserId(), 15000, 'user.current');
				if (!BETA_USER_IDS.includes(uid)) {
					setPhase({ k: 'denied' });
					return;
				}
				// инициаторы не критичны (бета = инициатор) — с таймаутом и фолбэком
				let initiators: string[] = [];
				try {
					initiators = await withTimeout(getInitiators(), 8000, 'app.option.get');
				} catch {
					initiators = [];
				}
				const init = BETA_USER_IDS.includes(uid) || initiators.includes(uid);
				setIsInitiator(init);

				// критичное: точки + сотрудники (эти методы уже работают в других экранах)
				const sts = await withTimeout(fetchStores(), 15000, 'catalog.store.list');
				const usrs = init ? await withTimeout(fetchUsers(), 15000, 'user.get').catch(() => [] as SimpleUser[]) : [];
				setMe({ id: uid, name: usrs.find((u) => u.id === uid)?.name ?? uid });
				setStores(sts.filter((s) => s.active));
				setUsers(usrs);
				setPhase({ k: 'ready' }); // рендерим модуль уже здесь — хранилище не блокирует

				// хранилище (entity) — в фоне; зависание/ошибка не вешает экран, а показывает предупреждение
				void (async () => {
					try {
						setInventories(await withTimeout(listInventories(), 12000, 'entity.item.get'));
					} catch (e: unknown) {
						setStorageWarn(`${String(e instanceof Error ? e.message : e)} (если хранилище не создано — пусть Володя/админ откроет приложение)`);
					}
				})();
			})().catch((e: unknown) => setPhase({ k: 'error', msg: String(e instanceof Error ? e.message : e) }));
		});
	}, [ctx]);

	async function submitCreate(): Promise<void> {
		const points: InvPoint[] = Object.entries(picked)
			.filter(([, rid]) => rid)
			.map(([sid, rid]) => {
				const store = stores.find((s) => s.id === Number(sid));
				const user = users.find((u) => u.id === rid);
				return {
					storeId: Number(sid),
					storeName: store?.title ?? `склад #${sid}`,
					responsibleId: rid,
					responsibleName: user?.name ?? rid,
				};
			});
		if (!title.trim() || !points.length) return;
		setSaving(true);
		const now = new Date().toISOString();
		try {
			if (ctx.__mock) {
				setInventories((prev) => [
					{ id: String(prev.length + 1), title: title.trim(), status: 'active', points, createdById: me.id, createdAt: now },
					...prev,
				]);
			} else {
				await withTimeout(createInventory(title.trim(), points, me.id, now), 15000, 'entity.item.add');
				setInventories(await withTimeout(listInventories(), 12000, 'entity.item.get'));
			}
			setCreating(false);
			setTitle('');
			setPicked({});
		} catch (e) {
			setPhase({ k: 'error', msg: `Не удалось создать: ${String(e instanceof Error ? e.message : e)}` });
		} finally {
			setSaving(false);
		}
	}

	if (phase.k === 'init') return <Shell><p>Загрузка…</p></Shell>;
	if (phase.k === 'denied') return <Shell><p className="stub-calm">Раздел инвентаризации в разработке. Пока доступен не всем.</p></Shell>;
	if (phase.k === 'error') return <Shell><p className="error">⛔ {phase.msg}</p></Shell>;

	// Менеджер (не инициатор): его точки
	if (!isInitiator) {
		const mine = inventories.filter((inv) => inv.status === 'active' && inv.points.some((p) => p.responsibleId === me.id));
		return (
			<div className="inv">
				<header><h1>Инвентаризация</h1><p className="subtitle">{me.name} · ваши точки</p></header>
				{mine.length ? mine.map((inv) => (
					<div className="inv-card" key={inv.id}>
						<strong>{inv.title}</strong>
						<ul>{inv.points.filter((p) => p.responsibleId === me.id).map((p) => (
							<li key={p.storeId}>{p.storeName} <span className="muted">— подсчёт скоро</span></li>
						))}</ul>
					</div>
				)) : <p className="stub-calm">Для вас сейчас нет активных инвентаризаций.</p>}
			</div>
		);
	}

	// Инициатор
	const canSave = Boolean(title.trim()) && Object.values(picked).some(Boolean);
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
					<input className="inv-input" placeholder="Название (напр. «Инвентаризация Июнь»)" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
					<p className="muted">Точки и ответственные:</p>
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
											<option value="">— ответственный —</option>
											{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
										</select>
									)}
								</div>
							);
						})}
					</div>
					<div className="inv-actions">
						<button className="btn-primary" disabled={saving || !canSave} onClick={() => void submitCreate()}>{saving ? 'Сохраняю…' : 'Создать'}</button>
						<button className="btn-secondary" onClick={() => { setCreating(false); setTitle(''); setPicked({}); }}>Отмена</button>
					</div>
				</div>
			)}

			{storageWarn && <div className="beta-banner">⚠️ Хранилище не отвечает: {storageWarn}. Список может быть пуст, а создание — не сохраниться. Похоже, упёрлись в entity-хранилище — напиши мне, добью.</div>}
			<h2 className="inv-h2">Инвентаризации</h2>
			{inventories.length ? inventories.map((inv) => (
				<div className="inv-card" key={inv.id}>
					<div className="inv-card-head">
						<strong>{inv.title}</strong>
						<span className={`badge ${inv.status}`}>{inv.status === 'active' ? 'активна' : inv.status}</span>
					</div>
					<ul>{inv.points.map((p) => (
						<li key={p.storeId}>{p.storeName} — <span className="muted">{p.responsibleName}</span> <span className="status-dot">⚪ не начато</span></li>
					))}</ul>
				</div>
			)) : <p className="stub-calm">Пока ни одной инвентаризации. Создайте первую.</p>}
		</div>
	);
}

function Shell({ children }: { children: JSX.Element }): JSX.Element {
	return <div className="inv"><header><h1>Инвентаризация</h1></header><section>{children}</section></div>;
}
