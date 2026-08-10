import type { Repair, RepairFile, RepairPhoto } from './b24.js';

function pad2(value: number): string {
	return value < 10 ? `0${value}` : String(value);
}

export function repairDate(value: string): string {
	if (!value) return '';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

export function repairDateTime(value: string): string {
	if (!value) return '';
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : `${repairDate(value)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Отображаемый номер: наш короткий (со 100), для старых карточек без него — технический ID. */
export function repairDisplayNumber(repair: Repair): number {
	return repair.repairNo && repair.repairNo > 0 ? repair.repairNo : repair.id;
}

export function repairMoney(value: number | null): string {
	return value == null ? '' : `${value.toLocaleString('ru-RU')} ₽`;
}

export function repairPointLabel(repair: Repair): string {
	if (repair.point) return repair.point;
	if (repair.kind === 'presale') return repair.sourceStore ?? repair.issueStore ?? '';
	return '';
}

export function repairCompleteness(repair: Repair): string {
	const value = String(repair.appearance ?? '').trim();
	const match = value.match(/(?:комплект(?:ация)?|в комплекте)\s*[:—-]?\s*(.+)$/i);
	return match?.[1]?.trim() || value || '—';
}

export function repairFileHref(file: RepairFile | RepairPhoto): string {
	return file.id > 0 ? `/api/repairs/file/${file.id}` : file.url;
}
