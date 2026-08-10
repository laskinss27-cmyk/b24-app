import { useMemo, useState } from 'react';
import {
	createCatalogProduct,
	type BaseRow,
	type CatalogAttributeType,
	type CatalogProductCandidate,
} from './b24.js';
import { formatCatalogNumber as fmt, PRODUCT_STATUS_OPTIONS } from './catalog-product-display.js';
import { prepareCatalogPhoto, type PreparedCatalogPhoto } from './catalog-product-photo.js';

function productKey(value: string | undefined): string {
	return String(value ?? '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, '');
}

function productNamePreview(productType: string, manufacturer: string, model: string): string {
	return [productType, manufacturer, model].map((value) => value.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' ');
}

function localProductCandidates(rows: BaseRow[], args: { name: string; manufacturer: string; model: string; isService: boolean }): CatalogProductCandidate[] {
	const wantedModel = productKey(args.model);
	const wantedBrand = productKey(args.manufacturer);
	const wantedName = productKey(args.name);
	return rows
		.filter((row) => row.isService === args.isService)
		.map((row) => {
			const rowModel = productKey(row.article || row.model);
			const rowBrand = productKey(row.manufacturer);
			const exact = Boolean(wantedName && productKey(row.name) === wantedName)
				|| Boolean(wantedModel && rowModel === wantedModel);
			let score = exact ? 100 : 0;
			if (!exact && wantedModel && rowModel === wantedModel) score += 70;
			else if (!exact && wantedModel && productKey(row.name).includes(wantedModel)) score += 45;
			if (!exact && wantedBrand && rowBrand === wantedBrand) score += 20;
			return { row, score, exact };
		})
		.filter((entry) => entry.score >= 45)
		.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name, 'ru'))
		.slice(0, 6)
		.map(({ row, exact }) => ({ ...row, exact }));
}

interface NewCatalogAttributeDraft {
	localId: string;
	key: string;
	label: string;
	group: string;
	type: CatalogAttributeType;
	rawValue: string;
	unit: string;
	filterable: boolean;
}

function catalogAttributeTemplate(rows: BaseRow[], sectionId: number): {
	category: string;
	attributes: NewCatalogAttributeDraft[];
	sourceCount: number;
} {
	const sectionRows = rows.filter((row) => row.sectionId === sectionId && row.content?.attributes.length);
	const categoryCounts = new Map<string, number>();
	for (const row of sectionRows) {
		const category = (row as BaseRow & { filterCategory?: string }).filterCategory?.trim() ?? '';
		if (category) categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
	}
	const category = [...categoryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))[0]?.[0] ?? '';
	const sourceRows = category
		? sectionRows.filter((row) => (row as BaseRow & { filterCategory?: string }).filterCategory === category)
		: sectionRows;
	const definitions = new Map<string, { attribute: NonNullable<BaseRow['content']>['attributes'][number]; count: number }>();
	for (const row of sourceRows) {
		for (const attribute of row.content?.attributes ?? []) {
			const current = definitions.get(attribute.key);
			if (!current) definitions.set(attribute.key, { attribute, count: 1 });
			else current.count += 1;
		}
	}
	const attributes = [...definitions.values()]
		.filter(({ attribute, count }) => attribute.filterable || count >= Math.max(2, Math.ceil(sourceRows.length * 0.35)))
		.sort((a, b) =>
			a.attribute.group.localeCompare(b.attribute.group, 'ru')
			|| a.attribute.label.localeCompare(b.attribute.label, 'ru'))
		.slice(0, 80)
		.map(({ attribute }, index): NewCatalogAttributeDraft => ({
			localId: `template:${attribute.key}:${index}`,
			key: attribute.key,
			label: attribute.label,
			group: attribute.group,
			type: attribute.type,
			rawValue: '',
			unit: attribute.unit,
			filterable: attribute.filterable,
		}));
	return { category, attributes, sourceCount: sourceRows.length };
}

export function NewCatalogProductModal({ rows, initialQuery, onUse, onClose }: {
	rows: BaseRow[];
	initialQuery: string;
	onUse: (row: BaseRow) => void;
	onClose: () => void;
}): JSX.Element {
	const [isService, setIsService] = useState(false);
	const [productType, setProductType] = useState('');
	const [manufacturer, setManufacturer] = useState('');
	const [model, setModel] = useState(initialQuery.trim());
	const [article, setArticle] = useState(initialQuery.trim());
	const [sectionId, setSectionId] = useState('');
	const [retailText, setRetailText] = useState('');
	const [purchaseText, setPurchaseText] = useState('0');
	const [summary, setSummary] = useState('');
	const [statuses, setStatuses] = useState<string[]>([]);
	const [attributes, setAttributes] = useState<NewCatalogAttributeDraft[]>([]);
	const [filterCategory, setFilterCategory] = useState('');
	const [templateSourceCount, setTemplateSourceCount] = useState(0);
	const [photo, setPhoto] = useState<PreparedCatalogPhoto | null>(null);
	const [photoBusy, setPhotoBusy] = useState(false);
	const [reviewed, setReviewed] = useState(false);
	const [serverCandidates, setServerCandidates] = useState<CatalogProductCandidate[] | null>(null);
	const [duplicateBlocked, setDuplicateBlocked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	const sections = useMemo(() => {
		const byId = new Map<number, string>();
		for (const row of rows) {
			if (row.sectionId && row.sectionName && row.isService === isService) byId.set(row.sectionId, row.sectionName);
		}
		if (!byId.size) {
			for (const row of rows) if (row.sectionId && row.sectionName) byId.set(row.sectionId, row.sectionName);
		}
		return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
	}, [isService, rows]);
	const preview = isService ? productType.trim().replace(/\s+/g, ' ') : productNamePreview(productType, manufacturer, model);
	const localCandidates = useMemo(
		() => localProductCandidates(rows, { name: preview, manufacturer, model, isService }),
		[rows, preview, manufacturer, model, isService],
	);
	const candidates = serverCandidates ?? localCandidates;
	const exactCandidate = duplicateBlocked || candidates.some((candidate) => candidate.exact);
	const retail = Number(retailText);
	const purchase = Number(purchaseText);
	const section = sections.find((item) => item.id === Number(sectionId));
	const validationError = (): string | null => {
		if (productType.trim().length < 3) return isService ? 'Укажи название услуги.' : 'Укажи вид товара.';
		if (!isService && manufacturer.trim().length < 2) return 'Укажи производителя.';
		if (!isService && model.trim().length < 2) return 'Укажи полную модель или артикул.';
		if (!section) return 'Выбери раздел каталога.';
		if (!(retail > 0)) return 'Цена продажи должна быть больше нуля.';
		if (!isService && (!Number.isFinite(purchase) || purchase < 0)) return 'Закупочная цена должна быть 0 или больше.';
		const filledAttributes = attributes.filter((attribute) => attribute.rawValue.trim());
		if (filledAttributes.some((attribute) => attribute.label.trim().length < 2)) return 'У каждой заполненной характеристики должно быть название.';
		if (exactCandidate) return 'Такая модель уже есть в каталоге. Выбери найденный товар.';
		if (candidates.length && !reviewed) return 'Проверь найденные совпадения и отметь «Это другая модель».';
		return null;
	};

	const resetReview = (): void => {
		setReviewed(false);
		setServerCandidates(null);
		setDuplicateBlocked(false);
		setErr(null);
	};

	const changeKind = (service: boolean): void => {
		setIsService(service);
		setSectionId('');
		setAttributes([]);
		setFilterCategory('');
		setTemplateSourceCount(0);
		setStatuses([]);
		setPhoto(null);
		resetReview();
	};

	const changeSection = (nextSectionId: string): void => {
		if (attributes.some((attribute) => attribute.rawValue.trim())
			&& !window.confirm('Сменить раздел и очистить уже заполненные характеристики?')) return;
		setSectionId(nextSectionId);
		const template = catalogAttributeTemplate(rows, Number(nextSectionId));
		setAttributes(template.attributes);
		setFilterCategory(template.category);
		setTemplateSourceCount(template.sourceCount);
		resetReview();
	};

	const reloadTemplate = (): void => {
		if (!section) return;
		if (attributes.some((attribute) => attribute.rawValue.trim())
			&& !window.confirm('Заново загрузить шаблон и очистить заполненные значения?')) return;
		const template = catalogAttributeTemplate(rows, section.id);
		setAttributes(template.attributes);
		setFilterCategory(template.category);
		setTemplateSourceCount(template.sourceCount);
	};

	const addAttribute = (): void => {
		setAttributes((current) => [...current, {
			localId: `new:${Date.now()}:${current.length}`,
			key: '',
			label: '',
			group: 'Дополнительно',
			type: 'text',
			rawValue: '',
			unit: '',
			filterable: false,
		}]);
	};

	const selectPhoto = async (file: File | undefined): Promise<void> => {
		if (!file) return;
		setPhotoBusy(true);
		setErr(null);
		try {
			setPhoto(await prepareCatalogPhoto(file));
		} catch (error) {
			setPhoto(null);
			setErr(String(error instanceof Error ? error.message : error));
		} finally {
			setPhotoBusy(false);
		}
	};

	const create = async (): Promise<void> => {
		const validationMessage = validationError();
		if (validationMessage || !section) {
			setErr(validationMessage ?? 'Проверь данные товара.');
			return;
		}
		setBusy(true);
		setErr(null);
		try {
			const input = {
				isService,
				productType: productType.trim(),
				manufacturer: isService ? '' : manufacturer.trim(),
				model: isService ? '' : model.trim(),
				article: isService ? '' : article.trim() || model.trim(),
				sectionId: section.id,
				sectionName: section.name,
				description: summary.trim(),
				status: isService ? '' : statuses.join(', '),
				summary: summary.trim(),
				filterCategory: filterCategory.trim() || section.name,
				attributes: (isService ? [] : attributes).map(({ key, label, group, type, rawValue, unit, filterable }) => ({
					key,
					label: label.trim(),
					group,
					type,
					rawValue: rawValue.trim(),
					unit,
					filterable,
				})),
				retail,
				purchase: isService ? 0 : purchase,
				...(!isService && photo ? { photo: { fileName: photo.fileName, mimeType: photo.mimeType, content: photo.content } } : {}),
				...(candidates.length && reviewed ? { similarReviewed: true } : {}),
			};
			const result = await createCatalogProduct(input);
			if (result.status === 'created') {
				onUse(result.product);
				return;
			}
			setServerCandidates(result.candidates);
			setReviewed(false);
			setDuplicateBlocked(result.status === 'duplicate');
			if (result.status === 'duplicate') setErr('Такая модель уже есть в каталоге.');
		} catch (error) {
			setErr(String(error instanceof Error ? error.message : error));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="new-product-overlay" onClick={onClose}>
			<div className="new-product-modal" onClick={(event) => event.stopPropagation()}>
				<div className="new-product-head">
					<div><span>Новая позиция каталога</span><h2>{preview || (isService ? 'Новая услуга' : 'Новый товар')}</h2></div>
					<button type="button" className="icon-close" aria-label="Закрыть" onClick={onClose}>×</button>
				</div>
				<div className="new-product-fields">
					<label className="wide new-product-service-toggle">
						<input type="checkbox" checked={isService} onChange={(event) => changeKind(event.target.checked)} />
						<span><b>Услуга</b><small>Нескладская позиция: без остатков, закупки и товарных характеристик.</small></span>
					</label>
					<label>{isService ? 'Название услуги' : 'Вид товара'}<input autoFocus value={productType} placeholder={isService ? 'Монтаж видеокамеры' : 'IP-камера'} onChange={(event) => { setProductType(event.target.value); resetReview(); }} /></label>
					{!isService && <label>Производитель<input value={manufacturer} placeholder="Hikvision" onChange={(event) => { setManufacturer(event.target.value); resetReview(); }} /></label>}
					{!isService && <label>Модель / артикул<input value={model} placeholder="DS-2CD2043G2-I" onChange={(event) => {
						const nextModel = event.target.value;
						setArticle((currentArticle) => currentArticle === model ? nextModel : currentArticle);
						setModel(nextModel);
						resetReview();
					}} /></label>}
					{!isService && <label>Артикул поставщика<input value={article} placeholder="если отличается от модели" onChange={(event) => setArticle(event.target.value)} /></label>}
					<label>Раздел<select value={sectionId} onChange={(event) => changeSection(event.target.value)}><option value="">Выбрать</option>{sections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
					<label>Цена продажи, ₽<input inputMode="decimal" value={retailText} placeholder="0" onChange={(event) => setRetailText(event.target.value.replace(',', '.'))} /></label>
					{!isService && <label>Закупочная цена, ₽<input inputMode="decimal" value={purchaseText} placeholder="0" onChange={(event) => setPurchaseText(event.target.value.replace(',', '.'))} /></label>}
					<div className="new-product-name wide"><span>Название</span><b>{preview || '—'}</b></div>
					{!isService && <fieldset className="wide new-product-statuses">
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
					</fieldset>}
					<label className="wide">Краткое описание<textarea rows={4} maxLength={4000} value={summary} placeholder={isService ? 'Что входит в услугу, условия и ограничения' : 'Что это за товар, для чего нужен, комплектация и совместимость'} onChange={(event) => setSummary(event.target.value)} /></label>
				</div>

				{!isService && <section className="new-product-photo-section">
					<div className="new-product-section-head">
						<div><b>Фото товара</b><span>Автоматически уменьшим до безопасного размера и сохраним в ядре.</span></div>
						<label className="btn-secondary new-product-photo-button">
							{photoBusy ? 'Подготавливаю…' : photo ? 'Заменить фото' : 'Выбрать фото'}
							<input type="file" accept="image/jpeg,image/png,image/webp" disabled={photoBusy || busy} onChange={(event) => void selectPhoto(event.target.files?.[0])} />
						</label>
					</div>
					{photo ? <div className="new-product-photo-preview">
						<img src={photo.previewUrl} alt="Предпросмотр товара" />
						<div><b>{photo.fileName}</b><span>{Math.ceil(photo.size / 1024)} КБ · JPEG</span><button type="button" onClick={() => setPhoto(null)}>Убрать</button></div>
					</div> : <div className="new-product-photo-empty">Фото необязательно при создании товара.</div>}
				</section>}

				{!isService && <section className="new-product-attributes">
					<div className="new-product-section-head">
						<div>
							<b>Характеристики</b>
							<span>{section
								? templateSourceCount > 0
									? `Шаблон «${filterCategory || section.name}» собран по ${templateSourceCount} карточкам этого раздела.`
									: 'Для этого раздела готового шаблона пока нет — добавь нужные поля вручную.'
								: 'Сначала выбери раздел — подставим совместимые поля для будущих фильтров.'}</span>
						</div>
						<div className="new-product-attribute-actions">
							{section && templateSourceCount > 0 && <button type="button" className="btn-secondary" onClick={reloadTemplate}>Вернуть шаблон</button>}
							<button type="button" className="btn-secondary" onClick={addAttribute}>+ Характеристика</button>
						</div>
					</div>
					<div className="new-product-attribute-list">
						{attributes.map((attribute, index) => (
							<div className="new-product-attribute-row" key={attribute.localId}>
								{attribute.localId.startsWith('new:')
									? <input
										aria-label="Название характеристики"
										placeholder="Название характеристики"
										value={attribute.label}
										onChange={(event) => setAttributes((current) => current.map((item, itemIndex) =>
											itemIndex === index ? { ...item, label: event.target.value } : item))}
									/>
									: <span title={`${attribute.group}${attribute.filterable ? ' · поле будущего фильтра' : ''}`}>
										{attribute.label}{attribute.filterable ? ' 🔒' : ''}
									</span>}
								{attribute.type === 'boolean'
									? <select
										aria-label={`Значение: ${attribute.label}`}
										value={attribute.rawValue}
										onChange={(event) => setAttributes((current) => current.map((item, itemIndex) =>
											itemIndex === index ? { ...item, rawValue: event.target.value } : item))}
									>
										<option value="">Не указано</option>
										<option value="Да">Да</option>
										<option value="Нет">Нет</option>
									</select>
									: <input
										aria-label={`Значение: ${attribute.label}`}
										placeholder={attribute.unit ? `Значение, ${attribute.unit}` : 'Значение'}
										value={attribute.rawValue}
										onChange={(event) => setAttributes((current) => current.map((item, itemIndex) =>
											itemIndex === index ? { ...item, rawValue: event.target.value } : item))}
									/>}
								<small>{attribute.group}{attribute.unit ? ` · ${attribute.unit}` : ''}</small>
								<button type="button" aria-label={`Убрать ${attribute.label || 'характеристику'}`} onClick={() =>
									setAttributes((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
							</div>
						))}
						{attributes.length === 0 && <p>Характеристик пока нет.</p>}
					</div>
				</section>}

				{candidates.length > 0 && (
					<div className={`new-product-matches${exactCandidate ? ' exact' : ''}`}>
						<div className="new-product-match-title">Совпадения в каталоге</div>
						{candidates.map((candidate) => (
							<button type="button" key={candidate.id} onClick={() => onUse(candidate)}>
								<span><b>{candidate.name}</b><small>{[candidate.manufacturer, candidate.article || candidate.model, candidate.sectionName].filter(Boolean).join(' · ')}</small></span>
								<span>{candidate.retail ? `${fmt(candidate.retail)} ₽` : `ID ${candidate.id}`}</span>
							</button>
						))}
						{!exactCandidate && <label className="new-product-confirm"><input type="checkbox" checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} /> Это другая модель</label>}
					</div>
				)}
				{err && <div className="new-product-error">{err}</div>}
				<div className="new-product-actions">
					<button type="button" className="btn-secondary" onClick={onClose}>Отмена</button>
					<button type="button" className="btn-primary" disabled={busy || photoBusy} onClick={() => void create()}>{busy ? 'Создаю…' : isService ? 'Создать услугу' : 'Создать товар'}</button>
				</div>
			</div>
		</div>
	);
}
