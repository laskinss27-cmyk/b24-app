import { useEffect, useState } from 'react';
import {
	createDealContract,
	fetchDealContractContext,
	type ContractDurationUnit,
	type ContractPartyKind,
	type ContractTemplateId,
	type DealContractContext,
} from './b24.js';
import { splitCard, splitGhost, splitOv } from './deal-modal-inline-styles.js';

export function ContractModal({ dealId, onClose, onDone }: {
	dealId: number;
	onClose: () => void;
	onDone: (message: string) => Promise<void>;
}): JSX.Element {
	const [context, setContext] = useState<DealContractContext | null>(null);
	const [companyId, setCompanyId] = useState(0);
	const [templateId, setTemplateId] = useState<ContractTemplateId>('universal_work');
	const [customerKind, setCustomerKind] = useState<ContractPartyKind>('person');
	const [contractDate, setContractDate] = useState(new Date().toISOString().slice(0, 10));
	const [objectAddress, setObjectAddress] = useState('');
	const [objectName, setObjectName] = useState('');
	const [workDuration, setWorkDuration] = useState(14);
	const [workDurationUnit, setWorkDurationUnit] = useState<ContractDurationUnit>('working');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchDealContractContext(dealId).then((data) => {
			if (!alive) return;
			setContext(data);
			setCompanyId(data.selectedCompanyId ?? data.ownCompanies[0]?.id ?? 0);
			setTemplateId(data.selectedTemplateId);
			setCustomerKind(data.customer?.kind ?? 'person');
			setContractDate(data.contractDate || new Date().toISOString().slice(0, 10));
			setObjectAddress(data.objectAddress);
			setWorkDuration(data.workDuration);
			setWorkDurationUnit(data.workDurationUnit);
		}).catch((reason) => {
			if (alive) setError(String(reason instanceof Error ? reason.message : reason));
		});
		return () => { alive = false; };
	}, [dealId]);

	const company = context?.ownCompanies.find((item) => item.id === companyId) ?? null;
	const template = context?.templates.find((item) => item.id === templateId) ?? null;
	const vatRate = company?.kind === 'ip' ? 5 : 22;
	const blockers = [
		...(company?.missing.map((field) => `Наша компания: ${field}`) ?? []),
		...(context?.customerMissingByKind[customerKind]?.map((field) => `Клиент: ${field}`) ?? []),
		...(!context?.customer && context ? ['В сделке не указан клиент'] : []),
		...(template && !template.available ? [`Шаблон «${template.title}» пока не подключён`] : []),
		...(template?.usesObjectAddress && !objectAddress.trim() ? ['Не указан адрес объекта'] : []),
		...(template?.usesObjectName && !objectName.trim() ? ['Не указано наименование объекта'] : []),
		...(template?.usesWorkDuration && (!Number.isInteger(workDuration) || workDuration < 1 || workDuration > 3650) ? ['Срок работ должен быть целым числом от 1 до 3650 дней'] : []),
	];

	const generate = async (): Promise<void> => {
		if (!context || !company || blockers.length || busy) return;
		setBusy(true);
		setError(null);
		try {
			const document = await createDealContract({
				dealId,
				companyId,
				templateId,
				customerKind,
				contractDate,
				objectAddress: objectAddress.trim(),
				objectName: objectName.trim(),
				workDuration,
				workDurationUnit,
			});
			await onDone(`✅ Договор № ${document.contractNumber} сформирован и добавлен в документы сделки.`);
		} catch (reason) {
			setError(String(reason instanceof Error ? reason.message : reason));
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={splitOv} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
			<div style={{ ...splitCard, maxWidth: 700 }}>
				<h2 style={{ fontSize: 18, margin: '0 0 4px' }}>Конструктор договора</h2>
				<div style={{ fontSize: 13, color: '#7a8699', marginBottom: 14 }}>Сделка #{dealId}. Номер и НДС определяются автоматически.</div>
				{!context && !error && <p style={{ color: '#7a8699' }}>Загружаю реквизиты из Битрикс24…</p>}
				{context && <>
					<div className="deal-contract-grid">
						<label className="wide"><span>Шаблон договора</span><select value={templateId} disabled={busy} onChange={(event) => setTemplateId(event.target.value as ContractTemplateId)}>
							{context.templates.map((item) => <option key={item.id} value={item.id} disabled={!item.available}>{item.title}{item.available ? '' : ' — готовится'}</option>)}
						</select></label>
						<label><span>Наша компания</span><select value={companyId} disabled={busy} onChange={(event) => setCompanyId(Number(event.target.value))}>
							{context.ownCompanies.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
						</select></label>
						<label><span>Заказчик</span><input value={context.customer?.title ?? 'Не указан'} readOnly /></label>
						<label><span>Тип клиента</span><select value={customerKind} disabled={busy} onChange={(event) => setCustomerKind(event.target.value as ContractPartyKind)}>
							<option value="ip">ИП</option>
							<option value="company">ООО</option>
							<option value="person">Физическое лицо</option>
						</select></label>
						<label><span>НДС автоматически</span><input value={`НДС ${vatRate}%`} readOnly /></label>
						<label><span>Дата договора</span><input type="date" value={contractDate} disabled={busy} onChange={(event) => setContractDate(event.target.value)} /></label>
						<label><span>Номер автоматически</span><input value="будет присвоен новый номер при создании" readOnly /></label>
						{template?.usesObjectName && <label className="wide"><span>Наименование объекта</span><input value={objectName} disabled={busy} onChange={(event) => setObjectName(event.target.value)} /></label>}
						{template?.usesWorkDuration && <>
							<label><span>Срок работ</span><input type="number" min={1} max={3650} step={1} value={workDuration} disabled={busy} onChange={(event) => setWorkDuration(Number(event.target.value))} /></label>
							<label><span>Единица срока</span><select value={workDurationUnit} disabled={busy} onChange={(event) => setWorkDurationUnit(event.target.value as ContractDurationUnit)}>
								<option value="working">Рабочие дни</option>
								<option value="calendar">Календарные дни</option>
							</select></label>
						</>}
						{template?.usesObjectAddress && <label className="wide"><span>Адрес объекта</span><input value={objectAddress} disabled={busy} onChange={(event) => setObjectAddress(event.target.value)} /></label>}
					</div>
					{blockers.length > 0 && <div className="deal-contract-blockers"><b>Договор пока сформировать нельзя:</b>{blockers.map((item) => <span key={item}>• {item}</span>)}</div>}
				</>}
				{error && <p style={{ color: '#c0392b', fontSize: 13 }}>⛔ {error}</p>}
				<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
					<button onClick={onClose} style={splitGhost} disabled={busy}>Отмена</button>
					<button className="btn-primary" disabled={!context || !company || blockers.length > 0 || busy} onClick={() => void generate()}>{busy ? 'Формирую…' : 'Сформировать договор'}</button>
				</div>
			</div>
		</div>
	);
}
