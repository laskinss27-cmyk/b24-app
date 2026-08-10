import { useState } from 'react';
import { photoFullUrl, type BaseRow, type CatalogProductUpdateInput, type StoreInfo } from './b24.js';
import { formatCatalogNumber as fmt, productStatuses, PRODUCT_STATUS_OPTIONS } from './catalog-product-display.js';
import { prepareCatalogPhoto, type PreparedCatalogPhoto } from './catalog-product-photo.js';

export function CatalogProductCard({
	row,
	stores,
	sections,
	canEdit,
	canEditPrices,
	showMarketplaceOldId,
	canEditMarketplaceOldId,
	onSave,
	onSaveMarketplaceOldId,
	onClose,
}: {
	row: BaseRow;
	stores: StoreInfo[];
	sections: Array<{ id: number; name: string }>;
	canEdit: boolean;
	canEditPrices: boolean;
	showMarketplaceOldId: boolean;
	canEditMarketplaceOldId: boolean;
	onSave: (input: CatalogProductUpdateInput) => Promise<void>;
	onSaveMarketplaceOldId: (oldId: string) => Promise<void>;
	onClose: () => void;
}): JSX.Element {
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(row.name);
	const [manufacturer, setManufacturer] = useState(row.manufacturer ?? '');
	const [model, setModel] = useState(row.model ?? '');
	const [article, setArticle] = useState(row.article ?? '');
	const [statuses, setStatuses] = useState(() => productStatuses(row.status));
	const [summary, setSummary] = useState(row.content?.summary ?? row.description ?? '');
	const [attributeEdits, setAttributeEdits] = useState(() =>
		(row.content?.attributes ?? []).map((attribute) => ({
			id: attribute.id,
			label: attribute.label,
			rawValue: attribute.rawValue,
			filterable: attribute.filterable,
			type: attribute.type,
			group: attribute.group,
		})));
	const [sectionId, setSectionId] = useState(String(row.sectionId ?? ''));
	const [retail, setRetail] = useState(String(row.retail ?? 0));
	const [purchase, setPurchase] = useState(String(row.purchase ?? 0));
	const [nextPhoto, setNextPhoto] = useState<PreparedCatalogPhoto | null>(null);
	const [photoBusy, setPhotoBusy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const [marketplaceOldId, setMarketplaceOldId] = useState(row.marketplaceOldId ?? '');
	const [marketplaceOldIdBusy, setMarketplaceOldIdBusy] = useState(false);
	const [marketplaceOldIdNotice, setMarketplaceOldIdNotice] = useState('');
	const currentPhoto = row.photoPath ? photoFullUrl(row.photoPath) : null;
	const displayedPhoto = nextPhoto?.previewUrl ?? currentPhoto;
	const stockRows = stores
		.map((store) => ({ ...store, qty: Number(row.stockByStore[store.id] ?? 0) }))
		.sort((a, b) => b.qty - a.qty || a.title.localeCompare(b.title, 'ru'));

	const reset = (): void => {
		setName(row.name);
		setManufacturer(row.manufacturer ?? '');
		setModel(row.model ?? '');
		setArticle(row.article ?? '');
		setStatuses(productStatuses(row.status));
		setSummary(row.content?.summary ?? row.description ?? '');
		setAttributeEdits((row.content?.attributes ?? []).map((attribute) => ({
			id: attribute.id,
			label: attribute.label,
			rawValue: attribute.rawValue,
			filterable: attribute.filterable,
			type: attribute.type,
			group: attribute.group,
		})));
		setSectionId(String(row.sectionId ?? ''));
		setRetail(String(row.retail ?? 0));
		setPurchase(String(row.purchase ?? 0));
		setNextPhoto(null);
		setError('');
		setEditing(false);
	};
	const selectPhoto = async (file: File | undefined): Promise<void> => {
		if (!file) return;
		setPhotoBusy(true);
		setError('');
		try {
			setNextPhoto(await prepareCatalogPhoto(file));
		} catch (reason) {
			setNextPhoto(null);
			setError(String(reason instanceof Error ? reason.message : reason));
		} finally {
			setPhotoBusy(false);
		}
	};
	const save = async (): Promise<void> => {
		const section = sections.find((item) => item.id === Number(sectionId));
		const retailValue = retail.trim() === '' ? NaN : Number(retail.replace(',', '.'));
		const purchaseValue = purchase.trim() === '' ? NaN : Number(purchase.replace(',', '.'));
		if (name.trim().length < 3) { setError('Название должно быть не короче трёх символов.'); return; }
		if (!section) { setError('Выбери раздел каталога.'); return; }
		if (!Number.isFinite(retailValue) || retailValue < 0 || !Number.isFinite(purchaseValue) || purchaseValue < 0) {
			setError('Обе цены должны быть 0 или больше.');
			return;
		}
		setBusy(true);
		setError('');
		try {
			await onSave({
				productId: row.id,
				iblockId: row.iblockId,
				name: name.trim(),
				isService: row.isService,
				article: article.trim(),
				model: model.trim(),
				manufacturer: manufacturer.trim(),
				sectionId: section.id,
				sectionName: section.name,
				status: statuses.join(', '),
				summary: summary.trim(),
				attributeEdits: attributeEdits.map(({ id, label, rawValue }) => ({ id, label, rawValue: rawValue.trim() })),
				retail: retailValue,
				purchase: purchaseValue,
				...(nextPhoto ? {
					photo: {
						fileName: nextPhoto.fileName,
						mimeType: nextPhoto.mimeType,
						content: nextPhoto.content,
					},
				} : {}),
			});
			setNextPhoto(null);
			setEditing(false);
		} catch (reason) {
			setError(String(reason instanceof Error ? reason.message : reason));
		} finally {
			setBusy(false);
		}
	};
	const saveMarketplaceOldId = async (): Promise<void> => {
		const oldId = marketplaceOldId.trim();
		if (oldId.length > 120) {
			setMarketplaceOldIdNotice('Старый ID не должен быть длиннее 120 символов.');
			return;
		}
		setMarketplaceOldIdBusy(true);
		setMarketplaceOldIdNotice('');
		try {
			await onSaveMarketplaceOldId(oldId);
			setMarketplaceOldId(oldId);
			setMarketplaceOldIdNotice(oldId ? 'Старый ID сохранён.' : 'Старый ID очищен.');
		} catch (reason) {
			setMarketplaceOldIdNotice(String(reason instanceof Error ? reason.message : reason));
		} finally {
			setMarketplaceOldIdBusy(false);
		}
	};

	return (
		<div className="catalog-product-overlay" onClick={onClose}>
			<div className="catalog-product-card" onClick={(event) => event.stopPropagation()}>
				<div className="catalog-product-card-head">
					<div>
						<span>{row.isService ? 'Услуга' : 'Товар'} · ID {row.id}</span>
						<h2>{row.name}</h2>
						{row.status && <div className="catalog-product-statuses">{productStatuses(row.status).map((status) => <b key={status} className="catalog-product-status">{status}</b>)}</div>}
					</div>
					<button type="button" className="icon-close" aria-label="Закрыть" onClick={onClose}>×</button>
				</div>
				<div className="catalog-product-card-body">
					<aside className="catalog-product-visual">
						{displayedPhoto
							? <img src={displayedPhoto} alt={row.name} onError={(event) => { event.currentTarget.style.display = 'none'; }} />
							: <div className="catalog-product-no-photo">Фото пока нет</div>}
						{editing && <div className="catalog-product-photo-editor">
							<label className="btn-secondary">
								{photoBusy ? 'Подготавливаю…' : currentPhoto || nextPhoto ? 'Заменить фото' : 'Добавить фото'}
								<input
									type="file"
									accept="image/jpeg,image/png,image/webp"
									disabled={photoBusy || busy}
									onChange={(event) => void selectPhoto(event.target.files?.[0])}
								/>
							</label>
							{nextPhoto && <small>{nextPhoto.fileName} · {Math.ceil(nextPhoto.size / 1024)} КБ</small>}
						</div>}
						<div className="catalog-product-totals">
							<div><span>Розница</span><b>{fmt(row.retail)} ₽</b></div>
							<div><span>Закупка</span><b>{fmt(row.purchase ?? 0)} ₽</b></div>
							{!row.isService && <div><span>Всего на складах</span><b>{fmt(row.total)} шт.</b></div>}
						</div>
					</aside>
					<main className="catalog-product-content">
						<section>
							<h3>Основная информация</h3>
							{editing ? (
								<div className="catalog-product-form">
									<label className="wide">Название<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
									<label>Производитель<input value={manufacturer} onChange={(event) => setManufacturer(event.target.value)} /></label>
									<label>Модель<input value={model} onChange={(event) => setModel(event.target.value)} /></label>
									<label>Артикул<input value={article} onChange={(event) => setArticle(event.target.value)} /></label>
									<label>Раздел<select value={sectionId} onChange={(event) => setSectionId(event.target.value)}><option value="">Выбрать</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
									<label>Розничная цена, ₽<input inputMode="decimal" value={retail} disabled={!canEditPrices} onChange={(event) => setRetail(event.target.value)} /></label>
									<label>Закупочная цена, ₽<input inputMode="decimal" value={purchase} disabled={!canEditPrices} onChange={(event) => setPurchase(event.target.value)} /></label>
									{!canEditPrices && <div className="wide catalog-price-permission-note">Цены показаны только для справки — право на их изменение настраивается отдельно.</div>}
									<fieldset className="wide catalog-status-editor">
										<legend>Статус товара</legend>
										<div>{PRODUCT_STATUS_OPTIONS.map((status) => <label key={status}>
											<input
												type="checkbox"
												checked={statuses.includes(status)}
												onChange={(event) => setStatuses((current) => event.target.checked
													? [...current, status]
													: current.filter((value) => value !== status))}
											/>
											{status}
										</label>)}</div>
									</fieldset>
									<label className="wide">Краткое описание<textarea rows={5} maxLength={4000} value={summary} placeholder="Что это за товар и для чего он нужен" onChange={(event) => setSummary(event.target.value)} /></label>
									<div className="wide catalog-attribute-editor">
										<div className="catalog-attribute-editor-head">
											<div>
												<b>Характеристики</b>
												<span>Названия и типы полей защищены. Значения автоматически подготовятся для будущих фильтров.</span>
											</div>
											<button type="button" className="btn-secondary" onClick={() => setAttributeEdits((current) => [...current, {
												id: `new:${Date.now()}`,
												label: '',
												rawValue: '',
												filterable: false,
												type: 'text',
												group: 'Дополнительно',
											}])}>+ Добавить</button>
										</div>
										{attributeEdits.map((attribute, index) => (
											<div className="catalog-attribute-edit-row" key={attribute.id}>
												{attribute.id.startsWith('new:')
													? <input
														aria-label="Название новой характеристики"
														placeholder="Название характеристики"
														value={attribute.label}
														onChange={(event) => setAttributeEdits((current) => current.map((item, itemIndex) =>
															itemIndex === index ? { ...item, label: event.target.value } : item))}
													/>
													: <span title={attribute.filterable ? 'Поле будущего фильтра — название защищено' : attribute.group}>
														{attribute.label}{attribute.filterable ? ' 🔒' : ''}
													</span>}
												{attribute.type === 'boolean'
													? <select
														value={attribute.rawValue}
														onChange={(event) => setAttributeEdits((current) => current.map((item, itemIndex) =>
															itemIndex === index ? { ...item, rawValue: event.target.value } : item))}
													>
														<option value="Да">Да</option>
														<option value="Нет">Нет</option>
													</select>
													: <input
														aria-label={`Значение: ${attribute.label}`}
														value={attribute.rawValue}
														onChange={(event) => setAttributeEdits((current) => current.map((item, itemIndex) =>
															itemIndex === index ? { ...item, rawValue: event.target.value } : item))}
													/>}
												{!attribute.filterable
													? <button type="button" className="catalog-attribute-remove" aria-label={`Удалить ${attribute.label}`} onClick={() =>
														setAttributeEdits((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
													: <span />}
											</div>
										))}
										{attributeEdits.length === 0 && <p className="muted">Характеристик пока нет. Можно добавить дополнительные поля вручную.</p>}
									</div>
								</div>
							) : (
								<dl className="catalog-product-info">
									<div><dt>Производитель</dt><dd>{row.manufacturer || '—'}</dd></div>
									<div><dt>Модель</dt><dd>{row.model || '—'}</dd></div>
									<div><dt>Артикул</dt><dd>{row.article || '—'}</dd></div>
									<div><dt>Раздел</dt><dd>{row.sectionName || '—'}</dd></div>
								</dl>
							)}
						</section>
						{showMarketplaceOldId && <section className="catalog-marketplace-id-section">
							<h3>Маркетплейсы</h3>
							<div className="catalog-marketplace-id-editor">
								<label>
									<span>Старый ID</span>
									<input
										value={marketplaceOldId}
										maxLength={120}
										disabled={!canEditMarketplaceOldId || marketplaceOldIdBusy}
										placeholder="Не заполнен"
										onChange={(event) => {
											setMarketplaceOldId(event.target.value);
											setMarketplaceOldIdNotice('');
										}}
									/>
								</label>
								{canEditMarketplaceOldId && <button
									type="button"
									className="btn-secondary"
									disabled={marketplaceOldIdBusy || marketplaceOldId.trim() === (row.marketplaceOldId ?? '')}
									onClick={() => void saveMarketplaceOldId()}
								>{marketplaceOldIdBusy ? 'Сохраняю…' : 'Сохранить ID'}</button>}
							</div>
							<p className="catalog-marketplace-id-help">Идентификатор товара из старой базы. Заполняется только после ручной проверки.</p>
							{marketplaceOldIdNotice && <div className="catalog-marketplace-id-notice">{marketplaceOldIdNotice}</div>}
						</section>}
						{!editing && <section>
							<h3>Описание и характеристики</h3>
							{row.content ? <div className="catalog-structured-description">
								{row.content.summary && <p>{row.content.summary}</p>}
								{row.content.attributes.length > 0 && <dl>{row.content.attributes.map((attribute) => (
									<div key={attribute.id}>
										<dt>{attribute.label}</dt>
										<dd>{attribute.rawValue}</dd>
									</div>
								))}</dl>}
							</div> : <div className={`catalog-product-description${row.description ? '' : ' empty'}`}>{row.description || 'Описание пока не заполнено.'}</div>}
						</section>}
						{!row.isService && <section>
							<h3>Остатки по складам</h3>
							<div className="catalog-product-stocks">
								{stockRows.map((store) => <div key={store.id}><span>{store.title}</span><b className={store.qty > 0 ? '' : 'zero'}>{fmt(store.qty)} шт.</b></div>)}
							</div>
						</section>}
						{error && <div className="new-product-error">{error}</div>}
					</main>
				</div>
				<div className="catalog-product-actions">
					{editing ? <>
						<button type="button" className="btn-secondary" disabled={busy || photoBusy} onClick={reset}>Отмена</button>
						<button type="button" className="btn-primary" disabled={busy || photoBusy} onClick={() => void save()}>{busy ? 'Сохраняю…' : 'Сохранить товар'}</button>
					</> : <>
						<button type="button" className="btn-secondary" onClick={onClose}>Закрыть</button>
						{canEdit && <button type="button" className="btn-primary" onClick={() => setEditing(true)}>Редактировать</button>}
					</>}
				</div>
			</div>
		</div>
	);
}
