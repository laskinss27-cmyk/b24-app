import { useEffect, useRef, useState } from 'react';
import { bx24Auth } from './bitrix-auth.js';
import { getContext } from './b24-context.js';

type DecisionResult = {
	ok: boolean;
	error?: string;
	status?: 'approved' | 'rejected';
	returns?: string[];
};

export function ReturnApproval(): JSX.Element {
	const ctx = getContext();
	const started = useRef(false);
	const [result, setResult] = useState<DecisionResult | null>(null);

	useEffect(() => {
		if (started.current) return;
		started.current = true;
		const requestId = Number(ctx.returnRequestId ?? 0);
		const decision = ctx.returnDecision;
		if (!Number.isInteger(requestId) || requestId <= 0 || (decision !== 'approve' && decision !== 'reject')) {
			setResult({ ok: false, error: 'Некорректная ссылка на заявку.' });
			return;
		}
		const decide = async (): Promise<void> => {
			try {
				const response = await fetch('/api/deal/return-requests/decision', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...bx24Auth(), requestId, decision }),
				});
				setResult(await response.json() as DecisionResult);
			} catch (error) {
				setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		};
		if (ctx.__mock || !window.BX24) void decide();
		else window.BX24.init(() => void decide());
	}, [ctx]);

	const approved = result?.ok && result.status === 'approved';
	const rejected = result?.ok && result.status === 'rejected';
	return <main style={{ minHeight: '100vh', background: '#f3f6f8', padding: 24, boxSizing: 'border-box' }}>
		<section style={{ maxWidth: 620, margin: '40px auto', background: '#fff', borderRadius: 12, padding: 28, boxShadow: '0 8px 30px rgba(31,45,61,.10)' }}>
			<h1 style={{ margin: '0 0 12px', fontSize: 22 }}>Заявка на возврат #{ctx.returnRequestId}</h1>
			{!result && <p>Обрабатываю решение…</p>}
			{approved && <><p style={{ color: '#168a45', fontWeight: 700 }}>Возврат одобрен и проведён.</p>{Boolean(result.returns?.length) && <p>Документы: {result.returns?.join(', ')}</p>}</>}
			{rejected && <p style={{ color: '#a15c00', fontWeight: 700 }}>Заявка отклонена. Возврат не создавался.</p>}
			{result && !result.ok && <p style={{ color: '#c0392b', fontWeight: 700 }}>Не удалось обработать заявку: {result.error ?? 'неизвестная ошибка'}</p>}
		</section>
	</main>;
}
