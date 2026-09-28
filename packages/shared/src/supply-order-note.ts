/** One common, mandatory comment for a deal supply order. */
export function requireSupplyOrderNote(value: unknown): string {
	const note = typeof value === 'string' ? value.trim() : '';
	if (!note) throw new Error('Заполните общий комментарий к заказу.');
	if (note.length > 500) throw new Error('Общий комментарий должен быть не длиннее 500 символов.');
	return note;
}
