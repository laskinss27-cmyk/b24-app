/** ERP messages are text for users, never HTML to insert into the page. */
export function erpPlainText(raw: string): string {
	const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
	let text = raw.slice(0, 32000);
	for (let pass = 0; pass < 2; pass++) {
		text = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, code: string) => {
			if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? entity;
			const number = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
			return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ? String.fromCodePoint(number) : '';
		});
	}
	return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function readableErpError(raw: string, status: number): string {
	const text = erpPlainText(raw);
	const shortage = text.match(/([\d.,]+)\s+единиц\s+(.+?)\s+необходимо в\s+(.+?)\s+для завершения этой транзакции/iu)
		?? text.match(/([\d.,]+)\s+units? of\s+(.+?)\s+(?:is |are )?(?:needed|required) in\s+(.+?)\s+to complete this transaction/iu);
	if (shortage) {
		const quantity = Number(shortage[1]?.replace(',', '.'));
		const amount = Number.isFinite(quantity) ? quantity.toLocaleString('ru-RU', { maximumFractionDigits: 9 }) : shortage[1];
		const item = shortage[2]?.replace(/^(?:Продукт|Item)\s+/iu, '');
		const warehouse = shortage[3]?.replace(/^(?:Склад|Warehouse)\s+/iu, '');
		return `Недостаточно товара на складе.\nТовар: ${item}.\nСклад: ${warehouse}.\nНе хватает: ${amount} учётных единиц.\nПроверьте количество в документе и движения товара по складу.`;
	}
	if (status === 401 || status === 403) return 'Складское ядро отказало в доступе. Обратитесь к администратору для проверки подключения и прав на операцию.';
	if (status >= 500) return 'Складское ядро вернуло внутреннюю ошибку. Проверьте статус документа перед повторной попыткой. Если ошибка повторится, обратитесь к администратору.';
	if (/NegativeStockError|insufficient stock|недостаточно (?:товара|остатк)/i.test(text)) return `Недостаточно товара на складе. Проверьте количество и движения товара.\n${text.slice(0, 2000)}`;
	return text.slice(0, 4000) || `Не удалось выполнить операцию в складском ядре (код ${status}).`;
}
