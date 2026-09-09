/** Validate document prices, never substitute catalogue prices or stock valuations. */
export function assertReceiptPrices(lines: Array<{ rate: unknown; itemCode?: unknown; itemName?: unknown }>): void {
	const invalid = lines.flatMap((line, index) => {
		const rate = Number(line.rate);
		if (Number.isFinite(rate) && rate > 0) return [];
		const code = String(line.itemCode ?? '').trim();
		const name = String(line.itemName ?? '').trim();
		return [`${index + 1}. ${name || (code ? `Товар #${code}` : 'Товар')}${name && code ? ` (#${code})` : ''}`];
	});
	if (invalid.length) throw new Error(`Нельзя оприходовать товары без закупочной цены. Заполните закупочную цену больше 0 ₽ для следующих позиций: ${invalid.join('; ')}. Затем повторите действие.`);
}
