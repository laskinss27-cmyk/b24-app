import { useEffect } from 'react';
import { openDeal } from './b24.js';

export function DealSupplyFallback({ dealId }: { dealId: number }): JSX.Element {
	useEffect(() => { openDeal(dealId); }, [dealId]);
	return <div className="supply-proto-state"><button className="btn-primary" type="button" onClick={() => openDeal(dealId)}>Открыть сделку #{dealId}</button></div>;
}
