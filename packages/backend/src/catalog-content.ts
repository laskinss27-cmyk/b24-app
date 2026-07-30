export type CatalogAttributeType = 'text' | 'option' | 'multi_option' | 'number' | 'range' | 'boolean';

export interface CatalogContentAttribute {
	id: string;
	key: string;
	label: string;
	group: string;
	type: CatalogAttributeType;
	rawValue: string;
	normalizedValue: string;
	numberValue: number | null;
	numberMin: number | null;
	numberMax: number | null;
	unit: string;
	booleanValue: boolean | null;
	filterable: boolean;
}

export interface CatalogProductContent {
	version: 1;
	summary: string;
	attributes: CatalogContentAttribute[];
}

export interface CatalogAttributeEdit {
	id: string;
	rawValue: string;
	label?: string;
}

export interface CatalogAttributeDefinitionInput {
	key?: string;
	label?: string;
	group?: string;
	type?: CatalogAttributeType;
	rawValue?: string;
	unit?: string;
	filterable?: boolean;
}

const cleanLine = (value: unknown): string => String(value ?? '').replace(/\s+/gu, ' ').trim();
const cleanMultiline = (value: unknown): string => String(value ?? '').replace(/\r\n?/gu, '\n').trim().slice(0, 10_000);
const ALLOWED_TYPES = new Set<CatalogAttributeType>(['text', 'option', 'multi_option', 'number', 'range', 'boolean']);

function nullableNumber(value: unknown): number | null {
	if (value == null || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

function parseNumberTokens(value: string): number[] {
	return [...value.matchAll(/[+\-−]?\d+(?:[.,]\d+)?/gu)]
		.map((match) => Number(match[0].replace('−', '-').replace(',', '.')))
		.filter(Number.isFinite);
}

function parseBoolean(value: string): boolean | null {
	const normalized = value.toLocaleLowerCase('ru-RU').replace(/ё/gu, 'е').trim();
	if (/^(?:да|есть|поддерживается|включен[ао]?|true|yes)$/u.test(normalized)) return true;
	if (/^(?:нет|отсутствует|не поддерживается|выключен[ао]?|false|no)$/u.test(normalized)) return false;
	return null;
}

export function parseCatalogContent(value: unknown): CatalogProductContent | undefined {
	if (!value) return undefined;
	try {
		const parsed = typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
		if (Number(parsed['version']) !== 1 || !Array.isArray(parsed['attributes'])) return undefined;
		const attributes = parsed['attributes'].flatMap((raw, index): CatalogContentAttribute[] => {
			if (!raw || typeof raw !== 'object') return [];
			const row = raw as Record<string, unknown>;
			const type = cleanLine(row['type']) as CatalogAttributeType;
			const label = cleanLine(row['label']);
			const key = cleanLine(row['key']);
			const rawValue = cleanLine(row['rawValue'] ?? row['raw']);
			if (!label || !key || !rawValue || !ALLOWED_TYPES.has(type)) return [];
			return [{
				id: cleanLine(row['id']) || `${key}:${index + 1}`,
				key,
				label,
				group: cleanLine(row['group']) || 'Дополнительно',
				type,
				rawValue,
				normalizedValue: cleanLine(row['normalizedValue'] ?? row['value']) || rawValue,
				numberValue: nullableNumber(row['numberValue'] ?? row['number']),
				numberMin: nullableNumber(row['numberMin'] ?? row['min']),
				numberMax: nullableNumber(row['numberMax'] ?? row['max']),
				unit: cleanLine(row['unit']),
				booleanValue: typeof (row['booleanValue'] ?? row['boolean']) === 'boolean'
					? Boolean(row['booleanValue'] ?? row['boolean'])
					: null,
				filterable: row['filterable'] === true,
			}];
		});
		return {
			version: 1,
			summary: cleanMultiline(parsed['summary']).slice(0, 4_000),
			attributes,
		};
	} catch {
		return undefined;
	}
}

function normalizeEditedAttribute(attribute: CatalogContentAttribute, rawValue: string): CatalogContentAttribute {
	const value = cleanLine(rawValue);
	if (!value) throw new Error(`Заполни значение характеристики «${attribute.label}»`);
	const next: CatalogContentAttribute = {
		...attribute,
		rawValue: value,
		normalizedValue: value,
		numberValue: null,
		numberMin: null,
		numberMax: null,
		booleanValue: null,
	};
	if (attribute.type === 'number') {
		const [number] = parseNumberTokens(value);
		if (number == null) throw new Error(`В характеристике «${attribute.label}» должно быть число`);
		next.numberValue = number;
		next.normalizedValue = String(number);
	} else if (attribute.type === 'range') {
		const numbers = parseNumberTokens(value);
		if (!numbers.length) throw new Error(`В характеристике «${attribute.label}» укажи число или диапазон`);
		next.numberMin = Math.min(...numbers);
		next.numberMax = Math.max(...numbers);
		next.normalizedValue = next.numberMin === next.numberMax
			? String(next.numberMin)
			: `${next.numberMin}…${next.numberMax}`;
	} else if (attribute.type === 'boolean') {
		const boolean = parseBoolean(value);
		if (boolean == null) throw new Error(`Для характеристики «${attribute.label}» выбери «Да» или «Нет»`);
		next.booleanValue = boolean;
		next.normalizedValue = boolean ? 'Да' : 'Нет';
	}
	return next;
}

function attributeKey(value: unknown, label: string): string {
	const explicit = cleanLine(value).toLocaleLowerCase('ru-RU')
		.replace(/[^a-z0-9_]+/gu, '_')
		.replace(/^_+|_+$/gu, '')
		.slice(0, 80);
	if (explicit) return explicit;
	const fromLabel = label.toLocaleLowerCase('ru-RU')
		.replace(/[^a-zа-яё0-9]+/gu, '_')
		.replace(/^_+|_+$/gu, '')
		.slice(0, 70);
	return fromLabel ? `custom_${fromLabel}` : 'additional_characteristic';
}

/**
 * Создаёт структурированное содержимое новой карточки.
 * Пустые необязательные поля не попадают в карточку; заполненные сразу нормализуются
 * тем же кодом, что и последующее редактирование, поэтому готовы для будущих фильтров.
 */
export function createCatalogContent(
	summaryInput: unknown,
	definitionsInput: unknown,
): CatalogProductContent {
	const summary = cleanMultiline(summaryInput).slice(0, 4_000);
	if (!Array.isArray(definitionsInput)) throw new Error('Сервер получил неверный список характеристик');
	if (definitionsInput.length > 250) throw new Error('В одной карточке не может быть больше 250 характеристик');
	const rows = definitionsInput.flatMap((raw): CatalogAttributeDefinitionInput[] => {
		if (!raw || typeof raw !== 'object') throw new Error('Сервер получил неверную характеристику');
		const row = raw as Record<string, unknown>;
		const rawValue = cleanLine(row['rawValue']);
		if (!rawValue) return [];
		return [{
			key: cleanLine(row['key']),
			label: cleanLine(row['label']),
			group: cleanLine(row['group']),
			type: cleanLine(row['type']) as CatalogAttributeType,
			rawValue,
			unit: cleanLine(row['unit']),
			filterable: row['filterable'] === true,
		}];
	});
	const usedKeys = new Set<string>();
	const attributes = rows.map((row, index): CatalogContentAttribute => {
		const label = cleanLine(row.label).slice(0, 120);
		if (label.length < 2) throw new Error('У характеристики должно быть понятное название');
		const type = ALLOWED_TYPES.has(row.type as CatalogAttributeType) ? row.type as CatalogAttributeType : 'text';
		const key = attributeKey(row.key, label);
		if (usedKeys.has(key)) throw new Error(`В карточке повторяется характеристика «${label}»`);
		usedKeys.add(key);
		return normalizeEditedAttribute({
			id: `${key}:${index + 1}`,
			key,
			label,
			group: cleanLine(row.group).slice(0, 120) || 'Дополнительно',
			type,
			rawValue: row.rawValue ?? '',
			normalizedValue: row.rawValue ?? '',
			numberValue: null,
			numberMin: null,
			numberMax: null,
			unit: cleanLine(row.unit).slice(0, 30),
			booleanValue: null,
			filterable: row.filterable === true,
		}, row.rawValue ?? '');
	});
	return { version: 1, summary, attributes };
}

export function applyCatalogContentEdits(
	current: CatalogProductContent,
	summaryInput: unknown,
	editsInput: unknown,
): CatalogProductContent {
	const summary = cleanMultiline(summaryInput).slice(0, 4_000);
	if (!Array.isArray(editsInput)) throw new Error('Сервер получил неверный список характеристик');
	const edits = editsInput.map((raw) => {
		if (!raw || typeof raw !== 'object') throw new Error('Сервер получил неверную характеристику');
		const row = raw as Record<string, unknown>;
		return {
			id: cleanLine(row['id']),
			rawValue: cleanLine(row['rawValue']),
			label: cleanLine(row['label']),
		};
	});
	if (edits.length > 250) throw new Error('В одной карточке не может быть больше 250 характеристик');
	const editById = new Map(edits.filter((row) => row.id && !row.id.startsWith('new:')).map((row) => [row.id, row]));
	if (editById.size !== edits.filter((row) => row.id && !row.id.startsWith('new:')).length) {
		throw new Error('В карточке повторяется характеристика');
	}
	const attributes = current.attributes.map((attribute) => {
		const edit = editById.get(attribute.id);
		if (!edit) {
			if (attribute.filterable) throw new Error(`Нельзя удалить характеристику будущего фильтра «${attribute.label}»`);
			return null;
		}
		return normalizeEditedAttribute(attribute, edit.rawValue);
	}).filter((attribute): attribute is CatalogContentAttribute => Boolean(attribute));
	for (const edit of edits.filter((row) => row.id.startsWith('new:'))) {
		const label = cleanLine(edit.label).slice(0, 120);
		if (label.length < 2) throw new Error('У новой характеристики должно быть понятное название');
		const id = `additional_characteristic:${Date.now()}:${attributes.length + 1}`;
		attributes.push(normalizeEditedAttribute({
			id,
			key: 'additional_characteristic',
			label,
			group: 'Дополнительно',
			type: 'text',
			rawValue: edit.rawValue,
			normalizedValue: edit.rawValue,
			numberValue: null,
			numberMin: null,
			numberMax: null,
			unit: '',
			booleanValue: null,
			filterable: false,
		}, edit.rawValue));
	}
	return { version: 1, summary, attributes };
}

export function renderCatalogDescription(content: CatalogProductContent): string {
	const characteristics = content.attributes
		.map((attribute) => `• ${attribute.label}: ${attribute.rawValue}`)
		.join('\n');
	return [content.summary, characteristics ? `Характеристики:\n${characteristics}` : '']
		.filter(Boolean)
		.join('\n\n')
		.slice(0, 10_000);
}

export function serializeFilterAttributes(content: CatalogProductContent, category: string): string {
	return JSON.stringify({
		version: 1,
		category,
		attributes: content.attributes.filter((attribute) => attribute.filterable).map((attribute) => ({
			key: attribute.key,
			label: attribute.label,
			type: attribute.type,
			value: attribute.normalizedValue,
			raw: attribute.rawValue,
			number: attribute.numberValue,
			min: attribute.numberMin,
			max: attribute.numberMax,
			unit: attribute.unit,
			boolean: attribute.booleanValue,
		})),
	});
}
