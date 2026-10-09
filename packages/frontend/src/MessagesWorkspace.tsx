import { useCallback, useEffect, useRef, useState } from 'react';
import { telegramApi, type TelegramApi } from './telegram-api.js';
import { TelegramWorkspace } from './TelegramWorkspace.js';
import './messages.css';
interface Contact { id:number;title:string }
interface Conversation { contactId:number;accountId:string;chatId:string;title:string;manager:string;enabled:boolean;status:string;lastSync:string|null }
interface Entry {id:number;date:string;outgoing:boolean;text:string;attachment:string|null;edited?:boolean;deleted?:boolean;manager:string;dialog:string}
interface Context {contacts:Contact[];dialogs:Conversation[];pendingMigration:number}
const empty:Context={contacts:[],dialogs:[],pendingMigration:0};
const key=(d:Conversation)=>`${d.accountId}:${d.chatId}`;
export function MessagesWorkspace({dealId,api=telegramApi}:{dealId:number|null;api?:TelegramApi}):JSX.Element {
 const [context,setContext]=useState<Context>(empty),[contact,setContact]=useState<number|null>(null),[messenger,setMessenger]=useState('telegram'),[conversation,setConversation]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[next,setNext]=useState<string|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(true),[reading,setReading]=useState(false),[managing,setManaging]=useState(false);
 const expanded=useRef(false);
 const contextSequence=useRef(0),historySequence=useRef(0),alive=useRef(true);
 const clear=()=>{expanded.current=false;historySequence.current++;setEntries([]);setNext(null);setConversation('');};
 const loadContext=useCallback(async()=>{if(!dealId){setLoading(false);return;}const seq=++contextSequence.current;
  try{const result=await api<Context>('client-context',{dealId});if(!alive.current||seq!==contextSequence.current)return;setContext(result);setContact(old=>result.contacts.some(c=>c.id===old)?old:result.contacts.length===1?result.contacts[0]!.id:null);setError('');}
  catch(e){if(alive.current&&seq===contextSequence.current){historySequence.current++;setContext(empty);setContact(null);setConversation('');setEntries([]);setNext(null);setError(e instanceof Error?e.message:'Не удалось проверить доступ к клиенту');}}
  finally{if(alive.current&&seq===contextSequence.current)setLoading(false);}
 },[api,dealId]);
 useEffect(()=>{alive.current=true;setContext(empty);setContact(null);clear();setLoading(true);void loadContext();const timer=setInterval(()=>{if(!document.hidden)void loadContext();},15000);return()=>{alive.current=false;contextSequence.current++;historySequence.current++;clearInterval(timer);};},[loadContext]);
 const dialogs=context.dialogs.filter(d=>d.contactId===contact),selected=dialogs.find(d=>key(d)===conversation);
 const read=useCallback(async(before?:string)=>{if(!dealId||!contact||!selected||messenger!=='telegram')return;const seq=++historySequence.current;setReading(true);
  try{const result=await api<{messages:Entry[];next:string|null}>('client-history',{dealId,contactId:contact,accountId:selected.accountId,chatId:selected.chatId,...(before?{before}:{})});if(!alive.current||seq!==historySequence.current)return;
   setEntries(old=>before||expanded.current?[...new Map([...old,...result.messages].map(m=>[m.id,m])).values()].sort((a,b)=>a.date.localeCompare(b.date)||a.id-b.id):result.messages);setNext(old=>before||!expanded.current?result.next:old);if(before)expanded.current=true;setError('');
  }catch(e){if(alive.current&&seq===historySequence.current){setEntries([]);setNext(null);setError(e instanceof Error?e.message:'Не удалось загрузить сообщения');}}
  finally{if(alive.current&&seq===historySequence.current)setReading(false);}
 },[api,dealId,contact,selected?.accountId,selected?.chatId,messenger]);
 useEffect(()=>{expanded.current=false;historySequence.current++;setEntries([]);setNext(null);setReading(false);if(!selected||managing||messenger!=='telegram')return;void read();const timer=setInterval(()=>{if(!document.hidden)void read();},15000);return()=>{historySequence.current++;clearInterval(timer);};},[read,managing]);
 return <main className="msg-workspace"><header className="msg-header"><div><h1>Сообщения</h1><p>Переписка клиента во всех его сделках</p></div><div className="msg-actions"><button onClick={()=>{clear();setManaging(v=>!v);}}>{managing?'К сообщениям':'Аккаунты и привязки'}</button><button disabled={loading||reading} onClick={()=>void loadContext().then(()=>read())}>Обновить</button></div></header>
 {error&&<p role="alert" className="tg-error">{error}</p>}
 {loading?<p role="status">Проверяем клиента сделки…</p>:<>
 {dealId&&context.contacts.length>1?<label className="msg-contact">Клиент сделки<select value={contact??''} onChange={e=>{clear();setContact(e.target.value?Number(e.target.value):null);}}><option value="">Выберите контакт</option>{context.contacts.map(c=><option key={c.id} value={c.id}>{c.title}</option>)}</select></label>:context.contacts[0]?<p className="msg-client"><strong>{context.contacts[0].title}</strong><span>Контакт № {context.contacts[0].id}</span></p>:dealId&&!error?<p className="tg-empty">Нет доступного контакта сделки. Добавьте контакт в Битрикс24 или проверьте права на него.</p>:null}
 {context.pendingMigration>0&&<p className="tg-notice">Для части прежних привязок нужно проверить контакт. Сохранённые сообщения не удалены. Откройте «Аккаунты и привязки».</p>}
 <nav className="msg-messengers" aria-label="Мессенджер">{[['telegram','Telegram'],['whatsapp','WhatsApp'],['max','MAX']].map(([id,title])=><button key={id} aria-pressed={messenger===id} onClick={()=>{clear();setMessenger(id!);setManaging(false);}}>{title}</button>)}</nav>
 {messenger!=='telegram'?<section className="tg-empty"><h2>{messenger==='whatsapp'?'WhatsApp':'MAX'} ещё не подключён к CRM</h2><p>{messenger==='whatsapp'?'Для рабочих диалогов понадобится отдельное подключение рабочего аккаунта.':'Рабочая интеграция этого мессенджера пока не настроена.'}</p></section>:managing||!dealId?<TelegramWorkspace key={contact??'none'} dealId={dealId} contactId={contact} managementOnly api={api}/>:contact?<div className="msg-layout"><aside className="msg-dialogs"><h2>Диалоги с менеджерами</h2>{dialogs.length?dialogs.map(d=><button key={key(d)} className="msg-dialog" aria-pressed={conversation===key(d)} onClick={()=>{historySequence.current++;setEntries([]);setNext(null);setConversation(key(d));}}><strong>Диалог · {d.manager}</strong><span>{d.title}</span><small>{!d.enabled?'Сбор приостановлен':d.status==='ready'?'Подключён':'Соединение недоступно · сохранённая история доступна'}</small></button>):<p>Пока нет привязанных диалогов Telegram.</p>}</aside><section className="msg-thread" aria-label="Выбранный диалог">{selected?<><h2>Диалог · {selected.manager}</h2><p className="msg-hint">Ответы отправляйте в Telegram. Здесь видна общая история этого диалога по всем сделкам клиента.</p>{next&&<button disabled={reading} onClick={()=>void read(next)}>Более ранние сообщения</button>}{reading&&<p role="status">Загружаем сообщения…</p>}<ol className="tg-messages">{entries.map(m=><li key={m.id} className={m.outgoing?'tg-message tg-outgoing':'tg-message'}><div className="tg-message-meta"><strong>{m.outgoing?selected.manager:selected.title}</strong><time dateTime={m.date}>{new Date(m.date).toLocaleString('ru-RU')}</time></div>{m.deleted?<p className="tg-muted">Сообщение удалено в Telegram</p>:<><p>{m.text}</p>{m.attachment&&<p className="tg-attachment">{m.attachment} · откройте в Telegram</p>}{m.edited&&<small>Изменено</small>}</>}</li>)}</ol>{!entries.length&&!reading&&!error&&<p>Сообщения ещё не получены.</p>}</>:<div className="tg-empty"><h2>Выберите диалог менеджера</h2><p>У каждого менеджера своя переписка с клиентом. Сообщения разных диалогов не смешиваются.</p></div>}</section></div>:null}
 </>}
 </main>;
}

export function MessagesLauncher({dealId}:{dealId:number|null}):JSX.Element {
 const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null);
 useEffect(()=>{if(open)dialog.current?.showModal();return()=>dialog.current?.close();},[open]);
 const close=()=>{setOpen(false);trigger.current?.focus();};
 return <><button ref={trigger} onClick={()=>setOpen(true)}>Сообщения</button>{open&&<dialog className="tg-modal" ref={dialog} aria-label="Сообщения клиента" onCancel={close}><button className="tg-close" onClick={close}>Закрыть</button><MessagesWorkspace dealId={dealId}/></dialog>}</>;
}
