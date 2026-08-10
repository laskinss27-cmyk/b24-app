import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ContractTemplateId, ContractTemplateInfo } from './deal-contract-types.js';

const ASSETS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

export const CONTRACT_TEMPLATES: readonly ContractTemplateInfo[] = [
	{
		id: 'universal_work',
		title: 'Универсальный договор подряда',
		available: true,
		ourRole: 'Подрядчик',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: false,
		usesWorkDuration: true,
	},
	{
		id: 'supply',
		title: 'Договор поставки (Shelly)',
		available: true,
		ourRole: 'Поставщик',
		customerRole: 'Покупатель',
		usesObjectAddress: false,
		usesObjectName: false,
		usesWorkDuration: false,
	},
	{
		id: 'design',
		title: 'Договор на проектирование',
		available: true,
		ourRole: 'Исполнитель',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: true,
		usesWorkDuration: false,
	},
	{
		id: 'smart_home',
		title: 'Универсальный договор «Умные дома»',
		available: true,
		ourRole: 'Подрядчик',
		customerRole: 'Заказчик',
		usesObjectAddress: true,
		usesObjectName: false,
		usesWorkDuration: true,
	},
] as const;

export const CONTRACT_TEMPLATE_PATHS: Record<ContractTemplateId, string> = {
	universal_work: resolve(ASSETS_PATH, 'contract-template.docx'),
	supply: resolve(ASSETS_PATH, 'contract-supply.docx'),
	design: resolve(ASSETS_PATH, 'contract-design.docx'),
	smart_home: resolve(ASSETS_PATH, 'contract-smart-home.docx'),
};

export const CONTRACT_FILENAME_TITLES: Record<ContractTemplateId, string> = {
	universal_work: 'Договор подряда',
	supply: 'Договор поставки',
	design: 'Договор на проектирование',
	smart_home: 'Договор подряда',
};

export const CONTRACT_REFERENCE_TITLES: Record<ContractTemplateId, string> = {
	universal_work: 'Договору подряда',
	supply: 'Договору поставки',
	design: 'Договору на выполнение проектных работ',
	smart_home: 'Договору подряда',
};
