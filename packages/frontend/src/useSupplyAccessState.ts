import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import {
	fetchCurrentAppAccess,
	fetchCurrentUserId,
	fetchStockFormData,
	fetchSupplyOrders,
	fetchSupplySuppliers,
	type SupplyOrderRow,
	withTimeout,
} from './b24.js';
import { MOCK_ORDERS } from './supply-mock-orders.js';
import type { SupplyViewKey } from './SupplyNavigation.js';

type SupplyPhase = 'init' | 'denied' | 'manager-link' | 'ready';
type SupplyStockForm = Awaited<ReturnType<typeof fetchStockFormData>>;

type UseSupplyAccessStateOptions = {
	mock: boolean;
	requestId: number;
	transferDeepLinkId: number;
	dealSupplyId: number;
	linkTarget: string;
	defaultSuppliers: string[];
	setOrders: Dispatch<SetStateAction<SupplyOrderRow[]>>;
	setView: Dispatch<SetStateAction<SupplyViewKey>>;
};

type SupplyAccessState = {
	phase: SupplyPhase;
	suppliers: string[];
	setSuppliers: Dispatch<SetStateAction<string[]>>;
	loading: boolean;
	currentUserId: string;
	canDeleteDocuments: boolean;
	marketplaceOnly: boolean;
	canOpenMarketplaces: boolean;
	stockForm: SupplyStockForm | null;
	setStockForm: Dispatch<SetStateAction<SupplyStockForm | null>>;
};

export function useSupplyAccessState({
	mock,
	requestId,
	transferDeepLinkId,
	dealSupplyId,
	linkTarget,
	defaultSuppliers,
	setOrders,
	setView,
}: UseSupplyAccessStateOptions): SupplyAccessState {
	const [phase, setPhase] = useState<SupplyPhase>('init');
	const [suppliers, setSuppliers] = useState<string[]>(defaultSuppliers);
	const [loading, setLoading] = useState(!mock);
	const [currentUserId, setCurrentUserId] = useState('');
	const [canDeleteDocuments, setCanDeleteDocuments] = useState(mock);
	const [marketplaceOnly, setMarketplaceOnly] = useState(false);
	const [canOpenMarketplaces, setCanOpenMarketplaces] = useState(mock);
	const [stockForm, setStockForm] = useState<SupplyStockForm | null>(mock
		? { stores: ['Максидом Дунайский 64', 'Максидом Богатырский 15', 'Максидом ул. Фаворского 12'], suppliers: defaultSuppliers, canCreate: true, isSupply: true }
		: null);

	useEffect(() => {
		if (mock) { setCurrentUserId('1858'); setPhase('ready'); return; }
		const bx = window.BX24;
		if (!bx) {
			setOrders(MOCK_ORDERS);
			setLoading(false);
			setPhase('ready');
			return;
		}
		bx.init(() => {
			void (async () => {
				const [uid, appAccess] = await Promise.all([
					withTimeout(fetchCurrentUserId(), 15000, 'user.current'),
					withTimeout(fetchCurrentAppAccess(), 20000, 'access-control/me').catch(() => null),
				]);
				const supplyDecision = appAccess?.decisions['supply.view'] ?? 'inherit';
				const marketplaceDecision = appAccess?.decisions['marketplaces.view'] ?? 'inherit';
				const access = supplyDecision === 'deny'
					? null
					: await withTimeout(fetchStockFormData(), 15000, 'stock.form-data').catch(() => null);
				setCurrentUserId(uid);
				if (access) setStockForm(access);
				const deleteDecision = appAccess?.decisions['supply.delete_documents'] ?? 'inherit';
				setCanDeleteDocuments(deleteDecision === 'allow' || (deleteDecision === 'inherit' && uid === '1858'));
				const hasSmartLink = requestId > 0 || transferDeepLinkId > 0 || dealSupplyId > 0;
				const managerLink = hasSmartLink && (linkTarget === 'manager' || (linkTarget !== 'supply' && !access?.isSupply));
				if (managerLink) {
					setLoading(false);
					setPhase('manager-link');
					return;
				}
				const canOpenSupply = supplyDecision === 'allow' || (supplyDecision === 'inherit' && Boolean(access?.canCreate));
				const canOpenMarketplace = marketplaceDecision === 'allow'
					|| (marketplaceDecision === 'inherit' && canOpenSupply);
				setCanOpenMarketplaces(canOpenMarketplace);
				if (!canOpenSupply && !canOpenMarketplace) { setLoading(false); setPhase('denied'); return; }
				if (!canOpenSupply && canOpenMarketplace) {
					setMarketplaceOnly(true);
					setView('marketplaces');
					setLoading(false);
					setPhase('ready');
					return;
				}
				setMarketplaceOnly(false);
				setPhase('ready');
				try {
					const [loaded, supplierList] = await Promise.all([fetchSupplyOrders(), fetchSupplySuppliers()]);
					setOrders(loaded);
					setSuppliers([...new Set([...supplierList, ...defaultSuppliers])].filter(Boolean));
				} catch {
					setOrders([]);
				} finally {
					setLoading(false);
				}
			})().catch(() => setPhase('denied'));
		});
	}, [dealSupplyId, defaultSuppliers, linkTarget, mock, requestId, setOrders, setView, transferDeepLinkId]);

	return {
		phase,
		suppliers,
		setSuppliers,
		loading,
		currentUserId,
		canDeleteDocuments,
		marketplaceOnly,
		canOpenMarketplaces,
		stockForm,
		setStockForm,
	};
}
