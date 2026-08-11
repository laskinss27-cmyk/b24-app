import { useCallback, useEffect, useState } from 'react';
import { openDeal } from './b24.js';
import { fetchOperationLog, type OperationLogEvent, type OperationLogOutcome } from './operation-log-api.js';

export interface OperationLogProps {
	onBack: () => void;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function operationLabel(operation: string): string {
	return ({ draft: 'Черновик', submit: 'Проведение', return: 'Возврат' } as Record<string, string>)[operation] ?? operation;
}

export function OperationLog({ onBack }: OperationLogProps): JSX.Element {
	const [outcome, setOutcome] = useState<OperationLogOutcome | undefined>();
	const [events, setEvents] = useState<OperationLogEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');

	const load = useCallback(async (): Promise<void> => {
		setLoading(true);
		setError('');
		try {
			setEvents(await fetchOperationLog(outcome));
		} catch (loadError) {
			setError(loadError instanceof Error ? loadError.message : String(loadError));
		} finally {
			setLoading(false);
		}
	}, [outcome]);

	useEffect(() => { void load(); }, [load]);

	return (
		<div className="operation-log">
			<header className="operation-log-header">
				<div>
					<button type="button" className="btn-secondary" onClick={onBack}>← База товаров</button>
					<h1>Журнал операций</h1>
					<p>Понятная история действий нашего приложения. Сейчас здесь отображаются реализации и возвраты.</p>
				</div>
				<button type="button" className="btn-secondary" onClick={() => void load()} disabled={loading}>↻ Обновить</button>
			</header>

			<div className="operation-log-filters" role="group" aria-label="Результат операции">
				{([[undefined, 'Все'], ['failure', 'Ошибки'], ['success', 'Успешные']] as const).map(([value, label]) => (
					<button key={label} type="button" className={outcome === value ? 'active' : ''} onClick={() => setOutcome(value)}>{label}</button>
				))}
			</div>

			{loading && <p className="operation-log-state">Загружаю журнал…</p>}
			{error && <p className="operation-log-state error">⛔ {error}</p>}
			{!loading && !error && events.length === 0 && <p className="operation-log-state">Записей пока нет.</p>}

			<div className="operation-log-list">
				{events.map((event) => (
					<article key={event.id} className={`operation-log-entry ${event.outcome}`}>
						<div className="operation-log-meta">
							<time>{formatDate(event.occurredAt)}</time>
							<span>{operationLabel(event.operation)}</span>
							{event.actor && <span>{event.actor.name}</span>}
						</div>
						<p>{event.summary}</p>
						<div className="operation-log-links">
							{event.deal && <button type="button" onClick={() => openDeal(event.deal!.id)}>Открыть сделку №{event.deal.id}</button>}
							{event.documents?.map((document) => <code key={document}>{document}</code>)}
						</div>
						{event.details && <details><summary>Технические детали</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}
					</article>
				))}
			</div>
		</div>
	);
}
