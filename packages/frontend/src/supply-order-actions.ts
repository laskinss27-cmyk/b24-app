import type { Dispatch, SetStateAction } from 'react';
import {
	createSupplySupplier,
	fetchStockFormData,
	updateSupplyOrderNote,
	updateSupplyOrderStore,
	type SupplyOrderRow,
} from './b24.js';

type SupplyStockForm = Awaited<ReturnType<typeof fetchStockFormData>>;

type CreateSupplyOrderActionsOptions = {
	mock: boolean;
	defaultSuppliers: string[];
	setOrders: Dispatch<SetStateAction<SupplyOrderRow[]>>;
	setSuppliers: Dispatch<SetStateAction<string[]>>;
	setStockForm: Dispatch<SetStateAction<SupplyStockForm | null>>;
	setNotice: Dispatch<SetStateAction<string | null>>;
	reload: () => Promise<void>;
	cancelReview: () => void;
	clearOrderDecisions: (orderName: string) => void;
};

type SupplyOrderActions = {
	refreshAfterRequestLineEdit: (order: SupplyOrderRow) => Promise<void>;
	saveOrderNote: (order: SupplyOrderRow, note: string) => Promise<void>;
	saveOrderStore: (order: SupplyOrderRow, toStore: string) => Promise<void>;
	addSupplier: (name: string) => Promise<string>;
};

export function createSupplyOrderActions({
	mock,
	defaultSuppliers,
	setOrders,
	setSuppliers,
	setStockForm,
	setNotice,
	reload,
	cancelReview,
	clearOrderDecisions,
}: CreateSupplyOrderActionsOptions): SupplyOrderActions {
	const refreshAfterRequestLineEdit = async (order: SupplyOrderRow): Promise<void> => {
		cancelReview();
		clearOrderDecisions(order.name);
		await reload();
		setNotice(`${order.name}: позиция синхронизирована со сделкой.`);
	};

	const saveOrderNote = async (order: SupplyOrderRow, note: string): Promise<void> => {
		const saved = mock ? note.trim() : await updateSupplyOrderNote(order.name, note);
		setOrders((current) => current.map((row) => row.name === order.name ? { ...row, note: saved } : row));
		setNotice(`${order.name}: комментарий сохранён.`);
	};

	const saveOrderStore = async (order: SupplyOrderRow, toStore: string): Promise<void> => {
		const saved = mock ? toStore.trim() : await updateSupplyOrderStore(order.name, order.requestKey, toStore);
		setOrders((current) => current.map((row) => row.name === order.name ? { ...row, toStore: saved } : row));
		clearOrderDecisions(order.name);
		cancelReview();
		setNotice(`${order.name}: конечный склад изменён на «${saved}». Распределение товаров нужно проверить заново.`);
	};

	const addSupplier = async (name: string): Promise<string> => {
		const clean = name.trim();
		if (mock) {
			setSuppliers((current) => [...new Set([...current, clean])].sort((a, b) => a.localeCompare(b, 'ru')));
			return clean;
		}
		const result = await createSupplySupplier(clean);
		const next = [...new Set([...result.suppliers, ...defaultSuppliers])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru'));
		setSuppliers(next);
		setStockForm((current) => current ? { ...current, suppliers: next } : current);
		setNotice(result.created ? `Поставщик «${result.name}» создан.` : `Поставщик «${result.name}» уже есть в справочнике.`);
		return result.name;
	};

	return {
		refreshAfterRequestLineEdit,
		saveOrderNote,
		saveOrderStore,
		addSupplier,
	};
}
