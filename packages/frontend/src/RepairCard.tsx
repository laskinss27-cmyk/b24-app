import { useEffect, useState } from 'react';
import {
	fetchStores,
	getRepairFileUrl,
	openDeal,
	openTask,
	type Repair,
	type RepairDealSyncResult,
	type RepairFile,
	type RepairStatus,
	type StoreInfo,
} from './b24.js';
import {
	repairDateTime as ruDateTime,
	repairDisplayNumber as repairNo,
	repairFileHref,
	repairMoney as money,
} from './repair-display.js';
import {
	isRepairStatusLocked as isLockedStatus,
	REPAIR_STATUS_LABELS as STATUS_LABEL,
	repairStatusFlow as flowFor,
} from './repair-status.js';

async function openRepairFile(file: RepairFile): Promise<void> {
	const win = window.open('', '_blank');
	try {
		const url = file.id > 0 ? await getRepairFileUrl(file.id) : file.url;
		if (!url) throw new Error('ссылка на файл пустая');
		if (win) win.location.href = url;
		else window.open(url, '_blank', 'noopener,noreferrer');
	} catch (error) {
		if (win) win.close();
		window.alert(String(error instanceof Error ? error.message : error));
	}
}


export function RepairCard({ repair, mock, canEditPrice, onBack, onEdit, onSaveInternalComment, onPrint, onIssuePrint, onStatus, onSetPay, onRequestPriceApproval, onSyncDeal, onSetIssueStore, onDelete }: {
	repair: Repair; mock: boolean; canEditPrice: boolean; onBack: () => void; onEdit: () => void; onSaveInternalComment: (comment: string) => Promise<void>; onPrint: () => void; onIssuePrint: () => void; onStatus: (s: RepairStatus) => Promise<RepairDealSyncResult>; onSetPay: (p: 'warranty' | 'paid', cost: number | null, ourPrice: number | null) => Promise<RepairDealSyncResult>; onRequestPriceApproval: (cost: number | null, ourPrice: number | null) => Promise<RepairDealSyncResult>; onSyncDeal: () => Promise<RepairDealSyncResult>; onSetIssueStore: (store: string) => Promise<void>; onDelete: () => Promise<void>;
}): JSX.Element {
	const [busy, setBusy] = useState(false);
	const [payBusy, setPayBusy] = useState(false);
	const [costVal, setCostVal] = useState<string>(repair.cost != null ? String(repair.cost) : '');
	const [ourVal, setOurVal] = useState<string>(repair.ourPrice != null ? String(repair.ourPrice) : '');
	const [stErr, setStErr] = useState<string | null>(null);
	const [dealMsg, setDealMsg] = useState<string | null>(repair.dealSyncWarning ? `⚠ ${repair.dealSyncWarning}` : null);
	const [issueStores, setIssueStores] = useState<StoreInfo[]>([]);
	const [issueVal, setIssueVal] = useState<string>(repair.issueStore ?? '');
	const [issueBusy, setIssueBusy] = useState(false);
	const [commentEditing, setCommentEditing] = useState(false);
	const [commentBusy, setCommentBusy] = useState(false);
	const [commentVal, setCommentVal] = useState(repair.internalComment ?? '');
	useEffect(() => { if (!mock) fetchStores().then((s) => setIssueStores(s.filter((x) => x.active))).catch(() => setIssueStores([])); }, [mock]);
	const presale = repair.kind === 'presale';
	const canPrintIssue = !presale && (repair.status === 'ready_tt' || repair.status === 'issued');
	// Заморозка: с «принято в офисе» КЛИЕНТСКУЮ карточку трогает только снабжение+. Предпродажный не замораживаем.
	const locked = isLockedStatus(repair.status) && !canEditPrice;
	// Финальная точка: для клиентского — «склад выдачи» (при «Готово к выдаче»); для предпродажного — «склад точки»
	// (выбрать перед «Отправлено на точку», туда вернётся при «Принято на ТТ»).
	const needsIssueStore = (s: RepairStatus): boolean => presale ? (s === 'pre_to_point' || s === 'pre_at_tt') : s === 'ready_tt';
	const costNum = (): number | null => (costVal.trim() !== '' && Number.isFinite(Number(costVal)) ? Number(costVal) : null);
	const ourNum = (): number | null => (ourVal.trim() !== '' && Number.isFinite(Number(ourVal)) ? Number(ourVal) : null);
	function reactDeal(res: RepairDealSyncResult): void {
		if (res.syncWarning) setDealMsg(`⚠ ${res.syncWarning}`);
		else if (res.dealCreated) setDealMsg('✓ Сделка по ремонту создана.');
		else if (res.dealNoContact) setDealMsg('⚠ Сделка не создана: у ремонта клиент без привязки к контакту Б24. Привяжи клиента в редактировании.');
		else setDealMsg('✓ Сделка синхронизирована.');
	}
	async function change(s: RepairStatus): Promise<void> {
		if (s === repair.status) return;
		// Переход, требующий финальный склад, без выбранного склада — не имеет смысла.
		if (needsIssueStore(s) && !issueVal.trim()) {
			setStErr(presale ? 'Сначала выбери склад точки — туда вернётся товар.' : 'Сначала выбери склад выдачи — туда переместится аппарат.');
			return;
		}
		setBusy(true); setStErr(null);
		try {
			const result = await onStatus(s);
			if (!presale) reactDeal(result);
		} catch (e: unknown) {
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setBusy(false);
		}
	}
	async function changeIssue(store: string): Promise<void> {
		const previous = issueVal;
		setIssueVal(store);
		setIssueBusy(true); setStErr(null);
		try {
			await onSetIssueStore(store);
		} catch (e: unknown) {
			setIssueVal(previous);
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setIssueBusy(false);
		}
	}
	async function changePay(p: 'warranty' | 'paid'): Promise<void> {
		if (p === repair.payType) return;
		setPayBusy(true); setStErr(null);
		try { reactDeal(await onSetPay(p, p === 'paid' ? costNum() : null, p === 'paid' ? ourNum() : null)); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); } finally { setPayBusy(false); }
	}
	async function savePrices(): Promise<void> {
		setPayBusy(true); setStErr(null);
		try { reactDeal(await onSetPay('paid', costNum(), ourNum())); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); } finally { setPayBusy(false); }
	}
	async function sendPriceApproval(): Promise<void> {
		setPayBusy(true); setStErr(null);
		try {
			const result = await onRequestPriceApproval(costNum(), ourNum());
			reactDeal(result);
			if (!result.syncWarning) setDealMsg('✓ Цена отправлена на согласование в чат точки, сделка синхронизирована.');
		} catch (e: unknown) {
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setPayBusy(false);
		}
	}
	async function repeatDealSync(): Promise<void> {
		setPayBusy(true); setStErr(null);
		try {
			reactDeal(await onSyncDeal());
		} catch (e: unknown) {
			setStErr(String(e instanceof Error ? e.message : e));
		} finally {
			setPayBusy(false);
		}
	}
	async function remove(): Promise<void> {
		if (busy) return;
		if (!window.confirm(`Удалить ремонт #${repairNo(repair)}? Действие необратимо.`)) return;
		setBusy(true); setStErr(null);
		try { await onDelete(); } catch (e: unknown) { setStErr(String(e instanceof Error ? e.message : e)); setBusy(false); }
	}
	async function saveInternalComment(): Promise<void> {
		setCommentBusy(true); setStErr(null);
		try {
			await onSaveInternalComment(commentVal.trim());
			setCommentEditing(false);
		} catch (error) {
			setStErr(String(error instanceof Error ? error.message : error));
		} finally {
			setCommentBusy(false);
		}
	}
	const row = (label: string, value: string): JSX.Element => (
		<div className="rc-row"><span className="rc-label">{label}</span><span className="rc-val">{value || '—'}</span></div>
	);
	return (
		<div className="repair-card">
			<div className="base-backbar"><button className="btn-secondary" onClick={onBack}>← К списку</button></div>
			<div className="rc-head">
				<h2>Ремонт #{repairNo(repair)}{repair.status === 'issued' && <span className="status-done"> · завершён</span>}</h2>
				<div className="rc-head-actions">
					<button className="btn-secondary" onClick={() => presale ? setCommentEditing(true) : onEdit()} disabled={locked} title={locked ? 'Принят в офисе — правит только снабжение' : undefined}>✎ {presale ? 'Редактировать комментарий' : 'Редактировать'}</button>
					<button className="btn-secondary" onClick={onPrint}>Акт приёма</button>
					{canPrintIssue && <button className="btn-primary" onClick={onIssuePrint}>Акт выдачи</button>}
					<button className="btn-danger" disabled={busy || locked} onClick={() => void remove()} title={locked ? 'Принят в офисе — удалить может только снабжение' : 'Удалить ремонт (необратимо)'}>🗑 Удалить</button>
				</div>
			</div>
			{locked && <p className="muted small">🔒 Ремонт принят в офисе — изменения (поля, цены, статус) доступны только снабжению.</p>}
			{(repair.taskId || !presale) && <div className="rc-related-links">
				{repair.taskId ? <button type="button" className="rc-related-link" onClick={() => openTask(repair.taskId!)}><span>Задача</span><b>#{repair.taskId}</b></button> : null}
				{!presale && repair.dealId ? <button type="button" className="rc-related-link" onClick={() => openDeal(repair.dealId!)}><span>Сделка</span><b>#{repair.dealId}</b></button> : null}
				{!presale ? <button type="button" className="btn-secondary" disabled={payBusy} onClick={() => void repeatDealSync()}>↻ Синхронизировать сделку</button> : null}
			</div>}
			{repair.taskWarning ? <p className="error">⚠ {repair.taskWarning}</p> : null}

			<div className="rc-status">
				<span className="rc-label">Статус</span>
				<select value={repair.status} disabled={busy || locked} onChange={(e) => void change(e.target.value as RepairStatus)}>
					{flowFor(repair.kind).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
				</select>
				{busy && <span className="muted small">сохраняю…</span>}
				{mock && <span className="muted small">(dev: статус не пишется)</span>}
			</div>

			<div className="rc-status">
				<span className="rc-label">{presale ? 'Склад точки' : 'Склад выдачи'}</span>
				<select value={issueVal} disabled={issueBusy || locked} onChange={(e) => void changeIssue(e.target.value)} title={presale ? 'Куда вернуть товар на точку. Выбери перед «Отправлено на точку» — туда товар встанет при «Принято на ТТ».' : 'Куда переместить аппарат при «Готово к выдаче». Клиент может забрать на другой точке.'}>
					<option value="">— не выбран —</option>
					{issueStores.map((s) => <option key={s.id} value={s.title}>{s.title}</option>)}
				</select>
				{issueBusy && <span className="muted small">сохраняю…</span>}
				{!issueVal.trim() && <span className="muted small">{presale ? 'выбери перед «Отправлено на точку»' : 'выбери перед «Готово к выдаче»'}</span>}
			</div>

			{!presale && (
				<div className="rc-pay">
					<span className="rc-label">Вид ремонта</span>
					<div className="rc-pay-toggle">
						<button className={`btn-secondary${repair.payType === 'warranty' ? ' active' : ''}`} disabled={payBusy || locked} onClick={() => void changePay('warranty')}>Гарантийный</button>
						<button className={`btn-secondary${repair.payType === 'paid' ? ' active' : ''}`} disabled={payBusy || locked} onClick={() => void changePay('paid')}>Платный</button>
					</div>
					{repair.payType === 'paid' && canEditPrice && (
						<span className="rc-pay-cost">
							<input type="number" min="0" step="1" value={costVal} placeholder="цена СЦ, ₽" disabled={payBusy} onChange={(e) => setCostVal(e.target.value)} title="Цена ремонта СЦ" />
							<input type="number" min="0" step="1" value={ourVal} placeholder="наша цена, ₽" disabled={payBusy} onChange={(e) => setOurVal(e.target.value)} title="Наша цена (→ сделка)" />
							<button className="btn-secondary" disabled={payBusy} onClick={() => void savePrices()}>Сохранить ₽</button>
							<button className="btn-primary" disabled={payBusy || ourNum() == null} onClick={() => void sendPriceApproval()} title={ourNum() == null ? 'Сначала укажи «Нашу цену»' : undefined}>Согласовать цену</button>
						</span>
					)}
					{repair.payType === 'paid' && !canEditPrice && (
						<span className="rc-pay-cost">СЦ <b>{repair.cost != null ? money(repair.cost) : '—'}</b> · наша <b>{repair.ourPrice != null ? money(repair.ourPrice) : '—'}</b> <span className="muted small">цены меняет руководитель / закупка</span></span>
					)}
					{payBusy && <span className="muted small">сохраняю…</span>}
				</div>
			)}
			{!presale && !repair.dealId && repair.client.contactId == null && <p className="muted small">⚠ Чтобы создать сделку ремонта — привяжи клиента к контакту Б24 (в редактировании).</p>}
			{dealMsg && <p className={dealMsg.startsWith('⚠') ? 'error' : 'muted small'}>{dealMsg}</p>}
			{stErr && <p className="error">⛔ {stErr}</p>}
			{presale && commentEditing && (
				<div className="rc-comment-editor">
					<label>Внутренний комментарий
						<textarea rows={3} maxLength={2000} value={commentVal} onChange={(event) => setCommentVal(event.target.value)} autoFocus />
					</label>
					<div className="rc-comment-editor-actions">
						<button className="btn-primary" type="button" disabled={commentBusy} onClick={() => void saveInternalComment()}>{commentBusy ? 'Сохраняю…' : 'Сохранить'}</button>
						<button className="btn-secondary" type="button" disabled={commentBusy} onClick={() => { setCommentVal(repair.internalComment ?? ''); setCommentEditing(false); }}>Отмена</button>
					</div>
				</div>
			)}

			<div className="rc-body">
				{presale ? (
					<>
						{row('Тип', '🛠 Предпродажный ремонт')}
						{row('Аппарат', repair.device || (repair.productId != null ? `#${repair.productId}` : ''))}
						{row('Склад-источник', repair.sourceStore ?? '')}
						{row('Сейчас на складе', repair.repairStore ?? '')}
						{row('Внутренний комментарий', repair.internalComment ?? '')}
						{row('Принят', ruDateTime(repair.createdAt))}
						{repair.createdByName && row('Принял', repair.createdByName)}
					</>
				) : (
					<>
						{row('Клиент', repair.client.name)}
						{row('Телефон', repair.client.phone)}
						{row('Оборудование', [repair.device, repair.model].filter(Boolean).join(' '))}
						{row('Серийный №', repair.serial)}
						{row('Торговая точка', repair.point)}
						{repair.payType === 'paid' && row('Цена ремонта СЦ', repair.cost != null ? money(repair.cost) : '—')}
						{repair.payType === 'paid' && row('Наша цена', repair.ourPrice != null ? money(repair.ourPrice) : '—')}
						{row('Внешний вид и комплектация', repair.appearance)}
						{row('Неисправность', repair.defect)}
						{row('Внутренний комментарий', repair.internalComment ?? '')}
						{row('Комментарий СЦ', repair.comment)}
						{row('Принят', ruDateTime(repair.createdAt))}
						{repair.createdByName && row('Принял', repair.createdByName)}
					</>
				)}
			</div>

			{repair.files.length > 0 && (
				<div className="rc-files">
					<span className="rc-label">Документы</span>
					<div className="rc-files-list">
						{repair.files.map((f, i) => (
							<a key={`${f.id}-${i}`} className="rc-file" href={f.url || '#'} onClick={(event) => { event.preventDefault(); void openRepairFile(f); }}>📄 {f.name}</a>
						))}
					</div>
				</div>
			)}

			{repair.photos.length > 0 && (
				<div className="rf-photos">
					{repair.photos.map((p, i) => <div key={`${p.id}-${i}`} className="rf-photo"><img src={repairFileHref(p)} alt={p.name} /></div>)}
				</div>
			)}

			{repair.history.length > 0 && (
				<div className="rc-history">
					<span className="rc-label">История</span>
					<div className="rc-history-list">
						{[...repair.history].slice().reverse().map((h, i) => (
							<div key={i} className="rc-hist-row">
								<span className="rc-hist-when">{ruDateTime(h.at)}</span>
								<span className="rc-hist-what">{h.note ? h.note : (STATUS_LABEL[h.status] ?? h.status)}</span>
								<span className="rc-hist-who">{h.byName || (h.byId ? `#${h.byId}` : '—')}</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}
