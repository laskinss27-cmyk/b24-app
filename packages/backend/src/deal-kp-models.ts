export interface KpProductIdentity {
	model?: string;
	article?: string;
	manufacturer?: string;
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Presentation only: quantities, prices, source names and catalog records are never edited. */
export function kpNameWithoutModel(name: string, identity: KpProductIdentity = {}): string {
	let result = name;
	const identifiers = [identity.model, identity.article, identity.manufacturer]
		.filter((value): value is string => Boolean(value?.trim()))
		.sort((a, b) => b.length - a.length);
	for (const identifier of identifiers) {
		// Unicode boundaries avoid removing a short brand/model from another word.
		const pattern = escape(identifier.trim()).replace(/\s+/g, '\\s+');
		result = result.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1');
	}
	// Legacy/manual lines may have no model field. Remove code-like words, not
	// technical quantities such as 4 Мп, 12 В, 8-канальный, Cat.6 or IP-камера.
	result = result.replace(/(?<![\p{L}\p{N}])[\p{L}\d][\p{L}\d./_-]*(?:\([\p{L}\d]+\))?/gu, (token) => {
		if (/\p{L}/u.test(token) && /\d/u.test(token) && !/^(?:IP\d{2}|Cat[.-]?\d[ae]?|\d+-[А-Яа-яЁё]+|\d+(?:[.,]\d+)?(?:Мп|мм|см|м|В|Вт|А|ГБ|ТБ|MP|mm|cm|V|W|GB|TB))$/iu.test(token)) return '';
		return token;
	});
	return result.replace(/\(\s*\)|\[\s*\]|«\s*»|"\s*"/gu, '')
		.replace(/\s+/gu, ' ').replace(/^[\s,;:./\-–—«»"()]+|[\s,;:./\-–—«»"()]+$/gu, '').trim() || 'Оборудование';
}
