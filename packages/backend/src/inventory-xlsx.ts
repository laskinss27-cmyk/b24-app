import ExcelJS from 'exceljs';
import type { InventoryExport, InventoryExportLine } from './inventory-export.js';

function moneyTotals(lines: InventoryExportLine[]) {
	let shortage = 0, surplus = 0, missing = 0;
	for (const line of lines) {
		if (line.diff === null || line.diff === 0) continue;
		if (line.purchase === null) { missing++; continue; }
		const cents = Math.round(Math.abs(line.diff) * line.purchase * 100);
		if (line.diff < 0) shortage += cents;
		else surplus += cents;
	}
	return { shortage: shortage / 100, surplus: surplus / 100, net: (surplus - shortage) / 100, missing };
}

const text = (value: string): string => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, 32767);
const statuses: Record<string, string> = { idle: 'Не начато', in_progress: 'В работе', submitted: 'Отправлено', act: 'Акт на сверке', reconciled: 'Сверено' };
const timestamp = (value: string): string => {
	const date = new Date(value);
	return !value || Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', {
		dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow',
	}).format(date);
};

export function createInventoryWorkbook(data: InventoryExport, now = new Date()): ExcelJS.Workbook {
	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Умный дом';
	workbook.created = now;
	const sheet = (name: string, headings: string[], widths: number[]): ExcelJS.Worksheet => {
		const ws = workbook.addWorksheet(name, { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
		ws.columns = widths.map((width) => ({ width }));
		ws.views = [{ state: 'frozen', ySplit: 5, showGridLines: false }];
		for (let row = 1; row <= 4; row++) ws.mergeCells(row, 1, row, headings.length);
		ws.getCell('A1').value = text(`${data.title} №${data.id}`);
		ws.getCell('A1').font = { name: 'Arial', size: 18, bold: true, color: { argb: 'FFFFFFFF' } };
		ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
		ws.getRow(1).height = 34;
		ws.getCell('A2').value = text(`Создана: ${timestamp(data.createdAt)}. Срок: ${data.deadline || 'не задан'}. Выгрузка: ${timestamp(now.toISOString())} (МСК).`);
		ws.getCell('A3').value = 'Сохранённые на сервере данные. Пустой факт означает, что значение не сохранено. Ноль — введённое количество.';
		ws.getCell('A4').value = 'Учёт — снимок ревизии. Расхождение = факт − учёт. Суммы — по сохранённой закупке; без цены сумма не рассчитана. Файл не изменяет остатки и документы.';
		for (let row = 2; row <= 4; row++) {
			ws.getRow(row).height = 30;
			ws.getRow(row).alignment = { wrapText: true, vertical: 'middle' };
			ws.getRow(row).font = { name: 'Arial', size: 10 };
		}
		ws.getRow(5).values = headings;
		ws.getRow(5).height = 34;
		ws.getRow(5).eachCell((cell) => {
			cell.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
			cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12345B' } };
			cell.alignment = { wrapText: true, vertical: 'middle' };
		});
		ws.pageSetup.printTitlesRow = '5:5';
		ws.headerFooter.oddFooter = 'Страница &P из &N';
		return ws;
	};
	const summary = sheet('Сводка', ['Склад', 'Ответственный', 'Статус', 'Снимок (МСК)', 'Позиций в файле', 'Сохранено фактов', 'Расхождений по известным значениям', 'Примечание', 'Недостача, ₽', 'Излишки, ₽', 'Итого: излишки − недостача, ₽'], [30, 27, 20, 22, 15, 17, 23, 64, 20, 20, 24]);
	const detail = sheet('Товары', ['Склад', 'ID товара', 'Товар', 'Артикул', 'Учёт', 'Факт', 'Расхождение', 'Комментарий', 'Сохранённая закупка, ₽', 'Сумма расхождения, ₽'], [30, 14, 55, 22, 16, 16, 18, 64, 22, 24]);
	for (const point of data.points) {
		const money = moneyTotals(point.lines);
		summary.addRow([text(point.storeName), text(point.responsible), statuses[point.status] ?? text(point.status), timestamp(point.snapshotAt),
			point.lines.length, point.lines.filter((line) => line.fact !== null).length,
			point.lines.filter((line) => line.diff !== null && Math.abs(line.diff) >= 1e-9).length,
			text(`${point.note}${money.missing ? ` Нет сохранённой закупки для ${money.missing} поз. с расхождением; суммы неполные.` : ''}`),
			money.missing ? null : money.shortage, money.missing ? null : money.surplus, money.missing ? null : money.net]);
		for (const line of point.lines) {
			const amount = line.diff !== null && line.purchase !== null ? Math.round(line.diff * line.purchase * 100) / 100 : null;
			const row = detail.addRow([text(point.storeName), String(line.productId), text(line.name || `Товар #${line.productId}`), text(line.article), line.book, line.fact, line.diff, text(line.comment), line.purchase, amount]);
			for (const column of [5, 6, 7]) row.getCell(column).numFmt = '#,##0.#########';
			for (const column of [9, 10]) row.getCell(column).numFmt = '#,##0.00';
			if (line.diff !== null && Math.abs(line.diff) >= 1e-9) row.getCell(7).fill = {
				type: 'pattern', pattern: 'solid', fgColor: { argb: line.diff < 0 ? 'FFFDE8E7' : 'FFE6F4EA' },
			};
		}
	}
	const total = moneyTotals(data.points.flatMap((point) => point.lines));
	summary.addRow(['Всего', '', '', '', '', '', '', total.missing ? 'Итог не рассчитан полностью: отсутствуют сохранённые цены.' : '',
		total.missing ? null : total.shortage, total.missing ? null : total.surplus, total.missing ? null : total.net]);
	for (let index = 6; index <= summary.rowCount; index++) {
		for (const column of [9, 10, 11]) summary.getRow(index).getCell(column).numFmt = '#,##0.00';
	}
	for (const ws of [summary, detail]) {
		ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, ws.rowCount - (ws === summary ? 1 : 0)), column: ws.columnCount } };
		ws.eachRow((row, index) => {
			if (index <= 5) return;
			row.font = { name: 'Arial', size: 11 };
			row.alignment = { wrapText: true, vertical: 'top' };
			let height = 30;
			row.eachCell((cell, col) => {
				if (typeof cell.value === 'string') {
					const chars = Math.max(8, (ws.getColumn(col).width ?? 20) - 3);
					const lines = cell.value.split('\n').reduce((sum, part) => sum + Math.max(1, Math.ceil(part.length / chars)), 0);
					height = Math.max(height, lines * 16 + 6);
				}
			});
			row.height = Math.min(409, height);
		});
	}
	return workbook;
}
