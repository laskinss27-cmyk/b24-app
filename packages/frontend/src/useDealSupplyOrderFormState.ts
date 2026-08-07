import { useState } from 'react';

export function useDealSupplyOrderFormState() {
	const [supplyBusy, setSupplyBusy] = useState(false);
	const [showSupplyOrder, setShowSupplyOrder] = useState(false);
	const [supplyNotes, setSupplyNotes] = useState<Record<string, string>>({});
	const [supplyQty, setSupplyQty] = useState<Record<string, string>>({});
	const [supplyToStore, setSupplyToStore] = useState('');
	const [supplyDeadline, setSupplyDeadline] = useState('');
	const [supplyOrderNote, setSupplyOrderNote] = useState('');
	const [supplyFormError, setSupplyFormError] = useState<string | null>(null);
	return {
		supplyBusy,
		setSupplyBusy,
		showSupplyOrder,
		setShowSupplyOrder,
		supplyNotes,
		setSupplyNotes,
		supplyQty,
		setSupplyQty,
		supplyToStore,
		setSupplyToStore,
		supplyDeadline,
		setSupplyDeadline,
		supplyOrderNote,
		setSupplyOrderNote,
		supplyFormError,
		setSupplyFormError,
	};
}
