import type { TransferDoc } from './b24.js';

export const TRANSFER_STATUS: Record<string, string> = { draft: 'Черновик', collected: 'Собрано', requested: 'Запрошено', in_transit: 'В пути', accepted: 'На проверке', posted: 'Принято', received: 'Получено', shortage: 'Недовоз', canceled: 'Отменено' };

export const transferStatusText = (transfer: TransferDoc): string => transfer.status === 'posted' && transfer.correctionOf
	? 'Завершено'
	: TRANSFER_STATUS[transfer.status] ?? transfer.status;
