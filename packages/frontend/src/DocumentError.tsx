import { useEffect, useRef } from 'react';

/** Visible to every operator; no owner/admin gate. Never renders server HTML. */
export function DocumentError({ message }: { message: string | null }): JSX.Element | null {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!message) return;
		ref.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
		ref.current?.focus({ preventScroll: true });
	}, [message]);
	if (!message) return null;
	return <div ref={ref} role="alert" tabIndex={-1} style={{ padding: '14px 16px', margin: '12px 0', border: '2px solid #b42318', borderRadius: 8, background: '#fff1f0', color: '#7a271a', overflowWrap: 'anywhere' }}>
		<strong>Не удалось завершить действие</strong>
		<div style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{message}</div>
	</div>;
}
