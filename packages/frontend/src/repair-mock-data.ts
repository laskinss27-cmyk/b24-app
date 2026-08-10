import type { Repair } from './b24.js';

export const MOCK_REPAIRS: Repair[] = [
	{
		id: 1042, repairNo: 102, name: 'Видеодомофон CTV-M5702 · Иванов', status: 'received_tt',
		client: { contactId: 16001, name: 'Иванов Пётр Сергеевич', phone: '+7 921 100-20-30' },
		device: 'Видеодомофон', model: 'CTV-M5702', serial: 'M5702-AB-7781', point: 'Дунайский 64', appearance: 'Царапина на рамке снизу. Комплект: монитор',
		defect: 'Не включается экран, питание есть', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: '', internalComment: 'Клиент просил позвонить после диагностики.', photos: [], files: [],
		createdAt: new Date().toISOString(), createdById: '1858', createdByName: 'Сергей Ласкин',
		history: [{ at: new Date().toISOString(), status: 'received_tt', byId: '1858' }],
	},
	{
		id: 1039, repairNo: 101, name: 'Контроллер Shelly Pro 4PM · ООО Дом', status: 'sent',
		client: { contactId: null, name: 'ООО «Умный дом»', phone: '+7 812 700-10-10' },
		device: 'Контроллер', model: 'Shelly Pro 4PM', serial: 'SH-4PM-55012', point: 'Измайловский 18Д', appearance: 'Без видимых повреждений. Комплект: контроллер, б/п',
		defect: 'Не отвечает по сети после грозы', payType: 'paid', cost: 3500, ourPrice: 5200, dealId: null, comment: 'СЦ: вне гарантии — замена платы питания', internalComment: 'Согласовать цену с клиентом до отправки.', photos: [], files: [],
		createdAt: new Date(Date.now() - 3 * 864e5).toISOString(), createdById: '1858', createdByName: 'Сергей Ласкин',
		history: [
			{ at: new Date(Date.now() - 3 * 864e5).toISOString(), status: 'received_tt', byId: '986', byName: 'Игорь Бекасов' },
			{ at: new Date(Date.now() - 2 * 864e5).toISOString(), status: 'received_office', byId: '78', byName: 'Даниил Андропов' },
			{ at: new Date(Date.now() - 2 * 864e5 + 36e5).toISOString(), status: 'sent', byId: '78', byName: 'Даниил Андропов', note: 'вид: платный, цена: 3500₽' },
		],
	},
	{
		id: 1031, repairNo: 100, name: 'IP-камера Dahua · Петров', status: 'issued',
		client: { contactId: 16044, name: 'Петров Иван', phone: '+7 905 222-33-44' },
		device: 'IP-камера', model: 'Dahua IPC-HFW2', serial: 'DH-2230-91кп', point: 'Дунайский 64', appearance: 'Потёртости корпуса. Комплект: камера, кронштейн',
		defect: 'Засветы по ИК-подсветке', payType: 'warranty', cost: null, ourPrice: null, dealId: null, comment: 'СЦ: неисправность не подтвердилась, прошивка обновлена', internalComment: '', photos: [], files: [],
		createdAt: new Date(Date.now() - 20 * 864e5).toISOString(), createdById: '986', createdByName: 'Игорь Бекасов',
		history: [],
	},
];
