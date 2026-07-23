import { useEffect, useMemo, useState } from 'react';
import { getContext } from './b24-context.js';
import {
	createMarketplaceBundle,
	createMarketplaceReturn,
	createMarketplaceSale,
	fetchMarketplaceFormData,
	fetchMarketplaceOperations,
	fetchMarketplaceReturnOptions,
	type MarketplaceFormData,
	type MarketplaceOperationKind,
	type MarketplaceOperationRow,
	type MarketplaceReturnOption,
} from './b24.js';
import { ProductBase, type ProductPickItem } from './ProductBase.js';

type OperationFilter = 'all' | MarketplaceOperationKind;

interface SaleLine {
	productId: number;
	itemName: string;
	qty: number;
	rate: number;
	stocks: Record<string, number>;
}

const OPERATION_LABELS: Record<MarketplaceOperationKind, string> = {
	sale: 'Реализация',
	bundle: 'Комплект',
	return: 'Возврат',
	writeoff: 'Списание',
	receipt: 'Зачисление комплекта',
};

const MOCK_FORM: MarketplaceFormData = {
	marketplaces: ['Озон', 'Wildberries', 'Яндекс Маркет'],
	stores: ['Shelly', 'Маркетплейс'],
	missingStores: [],
	canCreate: true,
};

const MOCK_ROWS: MarketplaceOperationRow[] = [{
	name: 'MAT-DN-2026-00001',
	title: '23.07.26_Озон',
	operation: 'sale',
	marketplace: 'Озон',
	date: '2026-07-23',
	storeTitle: 'Маркетплейс',
	submitted: true,
	total: 15990,
	itemCount: 2,
	quantity: 3,
}];

const money = (value: number): string =>
	`${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ₽`;

const localDate = (): string => {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60_000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

const operationTone = (operation: MarketplaceOperationKind): string =>
	operation === 'sale' ? 'sale'
		: operation === 'return' ? 'return'
			: operation === 'bundle' ? 'bundle'
				: 'neutral';

function MarketplaceSaleModal({
	form,
	mock,
	onClose,
	onDone,
}: {
	form: MarketplaceFormData;
	mock: boolean;
	onClose: () => void;
	onDone: (row: MarketplaceOperationRow) => void;
}): JSX.Element {
	const [marketplace, setMarketplace] = useState(form.marketplaces[0] ?? '');
	const [storeTitle, setStoreTitle] = useState(form.stores.includes('Маркетплейс') ? 'Маркетплейс' : (form.stores[0] ?? ''));
	const [postingDate, setPostingDate] = useState(localDate);
	const [lines, setLines] = useState<SaleLine[]>([]);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	const addPicked = (items: ProductPickItem[]): void => {
		setLines((current) => {
			const next = new Map(current.map((line) => [line.productId, line]));
			for (const item of items.filter((row) => !row.isService)) {
				const existing = next.get(item.productId);
				next.set(item.productId, {
					productId: item.productId,
					itemName: item.name,
					qty: (existing?.qty ?? 0) + Math.max(Number(item.quantity || 1), 1),
					rate: existing?.rate ?? Math.max(Number(item.price || 0), 0),
					stocks: item.stocks ?? existing?.stocks ?? {},
				});
			}
			return [...next.values()];
		});
	};

	const total = lines.reduce((sum, line) => sum + line.qty * line.rate, 0);
	const patchLine = (productId: number, patch: Partial<Pick<SaleLine, 'qty' | 'rate'>>): void =>
		setLines((current) => current.map((line) => line.productId === productId ? { ...line, ...patch } : line));

	const submit = async (): Promise<void> => {
		setError('');
		if (!marketplace) return setError('Выберите маркетплейс.');
		if (!storeTitle) return setError('Не найден склад Shelly или Маркетплейс.');
		if (!lines.length) return setError('Добавьте товары.');
		const invalid = lines.find((line) => !(line.qty > 0) || line.rate < 0);
		if (invalid) return setError(`Проверьте количество и цену: ${invalid.itemName}.`);
		const unavailable = lines.find((line) => line.qty > Number(line.stocks[storeTitle] ?? 0));
		if (unavailable) {
			return setError(`На складе «${storeTitle}» доступно ${Number(unavailable.stocks[storeTitle] ?? 0)}: ${unavailable.itemName}.`);
		}
		setBusy(true);
		try {
			const result = mock
				? { name: `MAT-DN-DEMO-${Date.now()}`, title: `${postingDate.slice(8, 10)}.${postingDate.slice(5, 7)}.${postingDate.slice(2, 4)}_${marketplace}` }
				: await createMarketplaceSale({
					marketplace,
					storeTitle,
					postingDate,
					lines: lines.map(({ productId, itemName, qty, rate }) => ({ productId, itemName, qty, rate })),
				});
			onDone({
				name: result.name,
				title: result.title,
				operation: 'sale',
				marketplace,
				date: postingDate,
				storeTitle,
				submitted: true,
				total,
				itemCount: lines.length,
				quantity: lines.reduce((sum, line) => sum + line.qty, 0),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (picking) {
		return (
			<div className="marketplace-picker">
				<ProductBase picker={{
					title: 'Товары для реализации на маркетплейсе',
					kindFilter: 'goods',
					onlyStockDefault: true,
					onCancel: () => setPicking(false),
					onDone: async (items) => { addPicked(items); setPicking(false); },
				}} />
			</div>
		);
	}

	return (
		<div className="marketplace-modal-backdrop">
			<section className="marketplace-modal" role="dialog" aria-modal="true" aria-labelledby="marketplace-sale-title">
				<header>
					<div><small>Новая операция</small><h2 id="marketplace-sale-title">Реализация</h2></div>
					<button type="button" className="marketplace-close" onClick={onClose} aria-label="Закрыть">×</button>
				</header>
				<div className="marketplace-sale-fields">
					<label>Маркетплейс<select value={marketplace} onChange={(event) => setMarketplace(event.target.value)}>{form.marketplaces.map((name) => <option key={name}>{name}</option>)}</select></label>
					<label>Склад списания<select value={storeTitle} onChange={(event) => setStoreTitle(event.target.value)}><option value="">Выберите склад</option>{form.stores.map((name) => <option key={name}>{name}</option>)}</select></label>
					<label>Дата реализации<input type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} /></label>
				</div>
				<div className="marketplace-line-toolbar">
					<button type="button" onClick={() => setPicking(true)}>+ Подобрать товары</button>
					<span>{lines.length ? `${lines.length} поз. · ${lines.reduce((sum, line) => sum + line.qty, 0)} шт.` : 'Товары ещё не выбраны'}</span>
				</div>
				<div className="marketplace-lines">
					<table>
						<thead><tr><th>Товар</th><th>Доступно</th><th>Количество</th><th>Цена</th><th>Сумма</th><th /></tr></thead>
						<tbody>
							{lines.length === 0
								? <tr><td className="marketplace-empty" colSpan={6}>Подберите товары из базы.</td></tr>
								: lines.map((line) => <tr key={line.productId}>
									<td><b>{line.itemName}</b><small>#{line.productId}</small></td>
									<td>{storeTitle ? Number(line.stocks[storeTitle] ?? 0) : '—'}</td>
									<td><input type="number" min="0.001" step="any" value={line.qty} onChange={(event) => patchLine(line.productId, { qty: Number(event.target.value) })} /></td>
									<td><input type="number" min="0" step="any" value={line.rate} onChange={(event) => patchLine(line.productId, { rate: Number(event.target.value) })} /></td>
									<td>{money(line.qty * line.rate)}</td>
									<td><button type="button" className="marketplace-remove" onClick={() => setLines((current) => current.filter((row) => row.productId !== line.productId))}>×</button></td>
								</tr>)}
						</tbody>
					</table>
				</div>
				<div className="marketplace-sale-total"><span>Итого</span><b>{money(total)}</b></div>
				{error && <div className="marketplace-error">{error}</div>}
				<footer>
					<button type="button" onClick={onClose}>Отмена</button>
					<button type="button" className="primary" disabled={busy || !form.canCreate} onClick={() => void submit()}>{busy ? 'Провожу…' : 'Провести реализацию'}</button>
				</footer>
			</section>
		</div>
	);
}

function MarketplaceBundleModal({
	form,
	mock,
	onClose,
	onDone,
}: {
	form: MarketplaceFormData;
	mock: boolean;
	onClose: () => void;
	onDone: (row: MarketplaceOperationRow) => void;
}): JSX.Element {
	const [source, setSource] = useState<ProductPickItem | null>(null);
	const [unitsPerBundle, setUnitsPerBundle] = useState(3);
	const [bundleQty, setBundleQty] = useState(1);
	const [postingDate, setPostingDate] = useState(localDate);
	const [picking, setPicking] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const marketplaceStore = form.stores.find((store) => store.toLocaleLowerCase('ru-RU') === 'маркетплейс') ?? '';
	const sourceQty = unitsPerBundle * bundleQty;
	const available = source && marketplaceStore ? Number(source.stocks?.[marketplaceStore] ?? 0) : 0;
	const bundleItemName = source ? `Комплект ${source.name} ${unitsPerBundle} шт` : '';

	const submit = async (): Promise<void> => {
		setError('');
		if (!source) return setError('Выберите исходный товар.');
		if (!marketplaceStore) return setError('Склад «Маркетплейс» не найден.');
		if (!Number.isInteger(unitsPerBundle) || unitsPerBundle < 2) return setError('В комплекте должно быть не меньше двух штук.');
		if (!Number.isInteger(bundleQty) || bundleQty < 1) return setError('Количество комплектов должно быть целым и больше нуля.');
		if (sourceQty > available) return setError(`На складе «Маркетплейс» доступно ${available} шт., требуется ${sourceQty} шт.`);
		setBusy(true);
		try {
			const result = mock
				? {
					name: `MAT-STE-DEMO-${Date.now()}`,
					title: `${postingDate.slice(8, 10)}.${postingDate.slice(5, 7)}.${postingDate.slice(2, 4)}_${bundleItemName}`,
					sourceQty,
					bundleProductId: 9900000 + source.productId,
					bundleItemName,
					bundleQty,
					storeTitle: marketplaceStore,
				}
				: await createMarketplaceBundle({
					sourceProductId: source.productId,
					unitsPerBundle,
					bundleQty,
					postingDate,
				});
			onDone({
				name: result.name,
				title: result.title,
				operation: 'bundle',
				marketplace: '',
				date: postingDate,
				storeTitle: result.storeTitle,
				submitted: true,
				total: 0,
				itemCount: 1,
				quantity: result.bundleQty,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (picking) {
		return (
			<div className="marketplace-picker">
				<ProductBase picker={{
					title: 'Товар для формирования комплекта',
					kindFilter: 'goods',
					onlyStockDefault: true,
					onCancel: () => setPicking(false),
					onDone: async (items) => {
						const picked = items.find((item) => !item.isService);
						if (picked) setSource(picked);
						setPicking(false);
					},
				}} />
			</div>
		);
	}

	return (
		<div className="marketplace-modal-backdrop">
			<section className="marketplace-modal marketplace-bundle-modal" role="dialog" aria-modal="true" aria-labelledby="marketplace-bundle-title">
				<header>
					<div><small>Новая операция</small><h2 id="marketplace-bundle-title">Сформировать комплект</h2></div>
					<button type="button" className="marketplace-close" onClick={onClose} aria-label="Закрыть">×</button>
				</header>
				<div className="marketplace-bundle-body">
					<div className="marketplace-bundle-source">
						<div>
							<span>Исходный товар</span>
							{source
								? <><b>{source.name}</b><small>#{source.productId} · на складе «Маркетплейс»: {available} шт.</small></>
								: <b>Товар не выбран</b>}
						</div>
						<button type="button" onClick={() => setPicking(true)}>{source ? 'Заменить' : 'Выбрать товар'}</button>
					</div>
					<div className="marketplace-sale-fields">
						<label>Штук в одном комплекте<input type="number" min="2" step="1" value={unitsPerBundle} onChange={(event) => setUnitsPerBundle(Number(event.target.value))} /></label>
						<label>Количество комплектов<input type="number" min="1" step="1" value={bundleQty} onChange={(event) => setBundleQty(Number(event.target.value))} /></label>
						<label>Дата формирования<input type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} /></label>
					</div>
					<div className="marketplace-bundle-result">
						<div><span>Будет списано</span><b>{source ? `${sourceQty} шт. · ${source.name}` : '—'}</b></div>
						<div className="marketplace-bundle-arrow">→</div>
						<div><span>Будет зачислено</span><b>{source ? `${bundleQty} шт. · ${bundleItemName}` : '—'}</b></div>
					</div>
				</div>
				{error && <div className="marketplace-error">{error}</div>}
				<footer>
					<button type="button" onClick={onClose}>Отмена</button>
					<button type="button" className="primary" disabled={busy || !form.canCreate} onClick={() => void submit()}>{busy ? 'Формирую…' : 'Сформировать'}</button>
				</footer>
			</section>
		</div>
	);
}

function MarketplaceReturnModal({
	form,
	mock,
	onClose,
	onDone,
}: {
	form: MarketplaceFormData;
	mock: boolean;
	onClose: () => void;
	onDone: (row: MarketplaceOperationRow) => void;
}): JSX.Element {
	const [product, setProduct] = useState<ProductPickItem | null>(null);
	const [options, setOptions] = useState<MarketplaceReturnOption[]>([]);
	const [saleName, setSaleName] = useState('');
	const [storeTitle, setStoreTitle] = useState(form.stores.includes('Маркетплейс') ? 'Маркетплейс' : (form.stores[0] ?? ''));
	const [postingDate, setPostingDate] = useState(localDate);
	const [qty, setQty] = useState(1);
	const [picking, setPicking] = useState(false);
	const [loadingOptions, setLoadingOptions] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const selectedSale = options.find((option) => option.saleName === saleName) ?? null;

	const selectProduct = async (item: ProductPickItem): Promise<void> => {
		setProduct(item);
		setOptions([]);
		setSaleName('');
		setQty(1);
		setError('');
		setLoadingOptions(true);
		try {
			const next = mock
				? [{
					saleName: 'MAT-DN-DEMO-1',
					saleTitle: '23.07.26_Озон',
					marketplace: 'Озон',
					saleDate: '2026-07-23',
					productId: item.productId,
					itemName: item.name,
					soldQty: 3,
					returnedQty: 0,
					availableQty: 3,
				}]
				: await fetchMarketplaceReturnOptions(item.productId);
			setOptions(next);
			setSaleName(next[0]?.saleName ?? '');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingOptions(false);
		}
	};

	const submit = async (): Promise<void> => {
		setError('');
		if (!product) return setError('Выберите товар.');
		if (!selectedSale) return setError('Выберите реализацию, из которой возвращается товар.');
		if (!storeTitle) return setError('Выберите склад возврата.');
		if (!(qty > 0)) return setError('Количество возврата должно быть больше нуля.');
		if (qty > selectedSale.availableQty) return setError(`Доступно для возврата ${selectedSale.availableQty} шт.`);
		setBusy(true);
		try {
			const result = mock
				? {
					name: `MAT-DN-RETURN-DEMO-${Date.now()}`,
					title: `${postingDate.slice(8, 10)}.${postingDate.slice(5, 7)}.${postingDate.slice(2, 4)}_Возврат_${selectedSale.marketplace}`,
					marketplace: selectedSale.marketplace,
					itemName: product.name,
					rate: 0,
					total: 0,
					qty,
					storeTitle,
				}
				: await createMarketplaceReturn({
					saleName: selectedSale.saleName,
					productId: product.productId,
					qty,
					storeTitle,
					postingDate,
				});
			onDone({
				name: result.name,
				title: result.title,
				operation: 'return',
				marketplace: result.marketplace,
				date: postingDate,
				storeTitle: result.storeTitle,
				submitted: true,
				total: result.total,
				itemCount: 1,
				quantity: result.qty,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	if (picking) {
		return (
			<div className="marketplace-picker">
				<ProductBase picker={{
					title: 'Товар, который вернул покупатель',
					kindFilter: 'goods',
					onlyStockDefault: false,
					onCancel: () => setPicking(false),
					onDone: async (items) => {
						const picked = items.find((item) => !item.isService);
						setPicking(false);
						if (picked) await selectProduct(picked);
					},
				}} />
			</div>
		);
	}

	return (
		<div className="marketplace-modal-backdrop">
			<section className="marketplace-modal marketplace-return-modal" role="dialog" aria-modal="true" aria-labelledby="marketplace-return-title">
				<header>
					<div><small>Новая операция</small><h2 id="marketplace-return-title">Возврат товара</h2></div>
					<button type="button" className="marketplace-close" onClick={onClose} aria-label="Закрыть">×</button>
				</header>
				<div className="marketplace-return-body">
					<div className="marketplace-bundle-source">
						<div>
							<span>Возвращаемый товар</span>
							{product ? <><b>{product.name}</b><small>#{product.productId}</small></> : <b>Товар не выбран</b>}
						</div>
						<button type="button" onClick={() => setPicking(true)}>{product ? 'Заменить' : 'Выбрать товар'}</button>
					</div>

					<label className="marketplace-return-sale">
						Реализация
						<select value={saleName} disabled={!options.length || loadingOptions} onChange={(event) => { setSaleName(event.target.value); setQty(1); }}>
							<option value="">{loadingOptions ? 'Ищу реализации…' : 'Выберите реализацию'}</option>
							{options.map((option) => <option key={option.saleName} value={option.saleName}>
								{option.saleTitle} · доступно {option.availableQty} из {option.soldQty}
							</option>)}
						</select>
					</label>

					{product && !loadingOptions && options.length === 0
						? <div className="marketplace-return-empty">В реализациях маркетплейсов этого товара нет либо всё количество уже возвращено.</div>
						: null}

					{selectedSale
						? <div className="marketplace-return-summary">
							<div><span>Маркетплейс</span><b>{selectedSale.marketplace}</b></div>
							<div><span>Продано</span><b>{selectedSale.soldQty} шт.</b></div>
							<div><span>Уже возвращено</span><b>{selectedSale.returnedQty} шт.</b></div>
							<div><span>Можно вернуть</span><b>{selectedSale.availableQty} шт.</b></div>
						</div>
						: null}

					<div className="marketplace-sale-fields">
						<label>Количество<input type="number" min="0.001" max={selectedSale?.availableQty} step="any" value={qty} onChange={(event) => setQty(Number(event.target.value))} /></label>
						<label>Склад возврата<select value={storeTitle} onChange={(event) => setStoreTitle(event.target.value)}><option value="">Выберите склад</option>{form.stores.map((name) => <option key={name}>{name}</option>)}</select></label>
						<label>Дата возврата<input type="date" value={postingDate} onChange={(event) => setPostingDate(event.target.value)} /></label>
					</div>
					<p className="marketplace-return-help">Товар вернётся на выбранный склад. Если продан комплект, он вернётся одной позицией и автоматически не разбирается.</p>
				</div>
				{error && <div className="marketplace-error">{error}</div>}
				<footer>
					<button type="button" onClick={onClose}>Отмена</button>
					<button type="button" className="primary" disabled={busy || loadingOptions || !selectedSale || !form.canCreate} onClick={() => void submit()}>{busy ? 'Провожу…' : 'Провести возврат'}</button>
				</footer>
			</section>
		</div>
	);
}

export function Marketplaces(): JSX.Element {
	const ctx = getContext();
	const [form, setForm] = useState<MarketplaceFormData | null>(ctx.__mock ? MOCK_FORM : null);
	const [rows, setRows] = useState<MarketplaceOperationRow[]>(ctx.__mock ? MOCK_ROWS : []);
	const [loading, setLoading] = useState(!ctx.__mock);
	const [error, setError] = useState('');
	const [notice, setNotice] = useState('');
	const [filter, setFilter] = useState<OperationFilter>('all');
	const [from, setFrom] = useState('');
	const [to, setTo] = useState('');
	const [saleOpen, setSaleOpen] = useState(false);
	const [bundleOpen, setBundleOpen] = useState(false);
	const [returnOpen, setReturnOpen] = useState(false);
	const [catalogOpen, setCatalogOpen] = useState(false);

	const load = async (): Promise<void> => {
		if (ctx.__mock) return;
		setLoading(true);
		setError('');
		try {
			const [nextForm, nextRows] = await Promise.all([
				fetchMarketplaceFormData(),
				fetchMarketplaceOperations({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
			]);
			setForm(nextForm);
			setRows(nextRows);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => { void load(); }, []);

	const visibleRows = useMemo(() =>
		filter === 'all' ? rows : rows.filter((row) => row.operation === filter), [rows, filter]);

	if (catalogOpen) {
		return (
			<section className="marketplace-catalog">
				<button type="button" className="marketplace-back" onClick={() => setCatalogOpen(false)}>← Назад в маркетплейсы</button>
				<ProductBase readOnly allowCreateProduct />
			</section>
		);
	}

	return (
		<section className="marketplace-page">
			<div className="marketplace-actions">
				<button type="button" className="marketplace-action primary" disabled={!form?.canCreate} onClick={() => setSaleOpen(true)}><span>↗</span><b>Реализация</b><small>Списать проданный товар</small></button>
				<button type="button" className="marketplace-action" onClick={() => setCatalogOpen(true)}><span>＋</span><b>Добавить новый товар</b><small>Открыть базу товаров</small></button>
				<button type="button" className="marketplace-action" disabled={!form?.canCreate} onClick={() => setBundleOpen(true)}><span>▦</span><b>Сформировать комплект</b><small>Объединить несколько штук</small></button>
				<button type="button" className="marketplace-action" disabled={!form?.canCreate} onClick={() => setReturnOpen(true)}><span>↩</span><b>Возврат товара</b><small>Вернуть из реализации</small></button>
			</div>

			{form?.missingStores.length ? <div className="marketplace-warning">В складском учёте не найдены: {form.missingStores.join(', ')}. До их создания реализацию провести нельзя.</div> : null}
			{!form?.canCreate && form ? <div className="marketplace-warning">Просмотр доступен. Проведение операций доступно сотрудникам снабжения.</div> : null}
			{notice && <div className="marketplace-notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')}>Закрыть</button></div>}
			{error && <div className="marketplace-error">{error}</div>}

			<div className="marketplace-journal">
				<header><div><h2>Журнал операций</h2><p>Реализации, возвраты, списания и комплекты</p></div><button type="button" onClick={() => void load()} disabled={loading}>{loading ? 'Загрузка…' : 'Обновить'}</button></header>
				<div className="marketplace-filters">
					<label>Тип операции<select value={filter} onChange={(event) => setFilter(event.target.value as OperationFilter)}>
						<option value="all">Все операции</option>
						{Object.entries(OPERATION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
					</select></label>
					<label>С<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
					<label>По<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
					<button type="button" onClick={() => void load()} disabled={loading}>Применить</button>
					<span>{visibleRows.length} операций</span>
				</div>
				<div className="marketplace-table-wrap">
					<table>
						<thead><tr><th>Операция</th><th>Название</th><th>Маркетплейс</th><th>Склад</th><th>Состав</th><th>Сумма</th><th>Статус</th></tr></thead>
						<tbody>
							{loading && rows.length === 0
								? <tr><td className="marketplace-empty" colSpan={7}>Загружаю операции…</td></tr>
								: visibleRows.length === 0
									? <tr><td className="marketplace-empty" colSpan={7}>Операций пока нет.</td></tr>
									: visibleRows.map((row) => <tr key={row.name}>
										<td><span className={`marketplace-kind ${operationTone(row.operation)}`}>{OPERATION_LABELS[row.operation]}</span></td>
										<td><b>{row.title}</b><small>{row.name}</small></td>
										<td>{row.marketplace || '—'}</td>
										<td>{row.storeTitle || '—'}</td>
										<td>{row.itemCount} поз. · {row.quantity} шт.</td>
										<td><b>{money(row.total)}</b></td>
										<td><span className={row.submitted ? 'marketplace-status done' : 'marketplace-status draft'}>{row.submitted ? 'Проведено' : 'Черновик'}</span></td>
									</tr>)}
						</tbody>
					</table>
				</div>
			</div>
			{saleOpen && form && <MarketplaceSaleModal form={form} mock={Boolean(ctx.__mock)} onClose={() => setSaleOpen(false)} onDone={(row) => { setRows((current) => [row, ...current]); setSaleOpen(false); setNotice(`Реализация «${row.title}» проведена.`); }} />}
			{bundleOpen && form && <MarketplaceBundleModal form={form} mock={Boolean(ctx.__mock)} onClose={() => setBundleOpen(false)} onDone={(row) => { setRows((current) => [row, ...current]); setBundleOpen(false); setNotice(`Комплект сформирован. Операция «${row.title}» проведена.`); }} />}
			{returnOpen && form && <MarketplaceReturnModal form={form} mock={Boolean(ctx.__mock)} onClose={() => setReturnOpen(false)} onDone={(row) => { setRows((current) => [row, ...current]); setReturnOpen(false); setNotice(`Возврат «${row.title}» проведён.`); }} />}
		</section>
	);
}
