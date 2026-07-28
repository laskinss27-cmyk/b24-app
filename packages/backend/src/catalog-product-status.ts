export interface CatalogProductNameStatus {
	name: string;
	status: string;
	hasInlineStatus: boolean;
}

const STATUS_ALIASES: ReadonlyArray<{
	status: string;
	pattern: string;
}> = [
	{ status: 'После ремонта', pattern: 'после\\s+ремонт(?:а)?' },
	{ status: 'Снят с производства', pattern: 'снят(?:о|а|ы)?\\s+с\\s+производства' },
	{ status: 'Недоступен к заказу', pattern: 'недоступ(?:ен|на|но|ны)?\\s+к\\s+заказу' },
	{ status: 'К удалению', pattern: 'к\\s+удалению|удалить' },
	{ status: 'Уценка', pattern: 'уценка!?' },
	{ status: 'Витринный', pattern: 'витринн(?:ый|ая|ое|ые)' },
	{ status: 'Б/у', pattern: 'б\\s*\\/\\s*у' },
	{ status: 'Распродажа', pattern: 'распродажа' },
	{ status: 'Повреждённый', pattern: 'поврежд[её]нн(?:ый|ая|ое|ые)' },
	{ status: 'Некондиция', pattern: 'некондиция' },
	{ status: 'Демо', pattern: 'демо' },
	{ status: 'Образец', pattern: 'образец' },
	{ status: 'Сток', pattern: 'сток' },
];

const INLINE_STATUS_RE = new RegExp(
	`(?:\\(|\\[)\\s*(${STATUS_ALIASES.map(({ pattern }) => `(?:${pattern})`).join('|')})\\s*(?:\\)|\\])`,
	'giu',
);

function canonicalStatus(value: string): string {
	const normalized = value.trim().replace(/\s+/gu, ' ');
	for (const alias of STATUS_ALIASES) {
		if (new RegExp(`^(?:${alias.pattern})$`, 'iu').test(normalized)) return alias.status;
	}
	return normalized;
}

/**
 * Keeps legacy status markers out of the visible product name.
 * Only explicit markers in parentheses or square brackets are recognized, so
 * ordinary words such as "водостоке" are never treated as a product status.
 */
export function splitCatalogProductNameStatus(
	value: unknown,
	storedStatus: unknown = '',
): CatalogProductNameStatus {
	const inlineStatuses: string[] = [];
	const rawName = String(value ?? '');
	const name = rawName
		.replace(INLINE_STATUS_RE, (marker) => {
			const status = canonicalStatus(String(marker).slice(1, -1));
			if (status) inlineStatuses.push(status);
			return ' ';
		})
		.replace(/\s+/gu, ' ')
		.trim();

	const statuses = String(storedStatus ?? '')
		.split(',')
		.map(canonicalStatus)
		.filter(Boolean);
	for (const status of inlineStatuses) {
		if (!statuses.includes(status)) statuses.push(status);
	}

	return {
		name,
		status: statuses.join(', '),
		hasInlineStatus: inlineStatuses.length > 0,
	};
}
