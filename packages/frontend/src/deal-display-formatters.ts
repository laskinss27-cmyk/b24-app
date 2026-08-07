import type { TransferDoc } from './b24.js';

export const rub = (n: number): string => `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;

/** Человеческая подпись стадии заявки снабжения (DT1110_114:NEW → «новая»). */
export const stageLabel = (stageId: string): string => {
	if (stageId.startsWith('CORE:')) {
		const status = stageId.slice(5).toLowerCase();
		if (status.includes('draft')) return 'черновик';
		if (status.includes('pending')) return 'новая';
		if (status.includes('ordered')) return 'заказано';
		if (status.includes('transferred') || status.includes('received') || status.includes('issued')) return 'выполнена';
		if (status.includes('stopped') || status.includes('cancel')) return 'отменена';
		return stageId.slice(5) || 'в ядре';
	}
	const tail = stageId.split(':')[1] ?? stageId;
	if (tail === 'NEW') return 'новая';
	if (tail === 'PREPARATION') return 'подготовка';
	if (tail === 'SUCCESS') return 'выполнена';
	if (tail === 'FAIL') return 'провалена';
	return 'в работе';
};

export const transferDocStatusLabel = (status: TransferDoc['status']): string => ({
	draft: 'черновик',
	collected: 'собрано',
	requested: 'запрошено',
	in_transit: 'в пути',
	accepted: 'на проверке',
	posted: 'проведено',
	received: 'получено',
	shortage: 'расхождение',
	canceled: 'отменено',
})[status];

/** Русская плюрализация: plural(2,'строка','строки','строк') → 'строки'. */
export const plural = (n: number, one: string, few: string, many: string): string => {
	const m10 = n % 10;
	const m100 = n % 100;
	if (m10 === 1 && m100 !== 11) return one;
	if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
	return many;
};
