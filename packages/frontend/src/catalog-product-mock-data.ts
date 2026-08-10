import type { BaseRow, StoreInfo } from './b24.js';

export const MOCK_CATALOG_STORES: StoreInfo[] = [
	{ id: 8, title: 'Максидом Дунайский 64', active: true },
	{ id: 10, title: 'Максидом Богатырский 15', active: true },
	{ id: 22, title: 'Максидом ул. Фаворского 12', active: true },
];

export const MOCK_CATALOG_ROWS: BaseRow[] = [
	{
		id: 1924, iblockId: 24, name: 'IP видеокамера уличная RL-IP54P 4Мп', isService: false,
		article: 'RL-IP54P', model: 'RL-IP54P', manufacturer: 'Redline', sectionId: 101,
		sectionName: 'Видеонаблюдение', status: 'Уценка, После ремонта',
		description: 'Уличная IP-камера.\n\nХарактеристики:\n• Разрешение: 4 Мп\n• Степень защиты: IP67',
		marketplaceOldId: '107790',
		content: {
			version: 1,
			summary: 'Уличная IP-камера для системы видеонаблюдения.',
			attributes: [
				{ id: 'resolution:1', key: 'resolution', label: 'Разрешение', group: 'Видео', type: 'option', rawValue: '4 Мп', normalizedValue: '4 Мп', numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null, filterable: true },
				{ id: 'protection_rating:2', key: 'protection_rating', label: 'Степень защиты', group: 'Эксплуатация', type: 'option', rawValue: 'IP67', normalizedValue: 'IP67', numberValue: null, numberMin: null, numberMax: null, unit: '', booleanValue: null, filterable: true },
			],
		},
		retail: 2890, purchase: 1740, total: 18, stockByStore: { 8: 12, 10: 6 },
	},
	{ id: 1810, iblockId: 24, name: 'Трубка аудиодомофона УКП-12', isService: false, article: 'УКП-12', model: 'УКП-12', manufacturer: '', sectionId: 102, sectionName: 'Домофоны', retail: 780, purchase: null, total: 8, stockByStore: { 8: 4, 22: 4 } },
	{ id: 1811, iblockId: 24, name: 'Трубка аудиодомофона УКП-12м', isService: false, article: 'УКП-12м', model: 'УКП-12м', manufacturer: 'Vizit', sectionId: 102, sectionName: 'Домофоны', retail: 820, purchase: 782, total: 9, stockByStore: { 8: 5, 10: 4 } },
	{ id: 2050, iblockId: 24, name: 'Компьютерный кабель UTP 5E (Cu) 305м', isService: false, article: 'UTP5E-IN', model: 'UTP5E-IN', manufacturer: 'Eletec', sectionId: 103, sectionName: 'Кабель и расходники', retail: 6200, purchase: 4800, total: 814, stockByStore: { 8: 514, 22: 300 } },
	{ id: 3001, iblockId: 24, name: 'Монтаж видеокамеры (работа)', isService: true, article: '', model: '', manufacturer: '', sectionId: 104, sectionName: 'Услуги', retail: 1500, purchase: null, total: 0, stockByStore: {} },
];
