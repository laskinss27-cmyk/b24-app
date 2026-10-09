import type { Account } from './store.js';
import { TelegramStore } from './store.js';
import type { Dialog } from './transport.js';
import { telegramPhone, type CrmReader } from './crm-match.js';
import { legacyContact, uniqueContactByPhone } from './contact-crm.js';
/** Contact identity is stable across deal closures and manager handoffs. */
export class ContactAutoBinder {
    private running=new Map<string,Promise<void>>();private next=new Map<string,number>();private checked=new Map<string,Map<string,number>>();private closed=false;
    constructor(private store:TelegramStore,private clientForOwner:(owner:string)=>Promise<CrmReader>,private now=Date.now){}
    run(account:Account,dialogs:()=>Promise<Dialog[]>,connected:()=>boolean):Promise<void>{
        if(this.running.has(account.id))return this.running.get(account.id)!;
        const state=this.store.autoState(account.id);
        if(this.closed||!account.active||!state.enabled||(this.next.get(account.id)??0)>this.now())return Promise.resolve();
        this.next.set(account.id,this.now()+60000);
        const active=()=>!this.closed&&connected()&&this.store.account(account.id).active&&this.store.autoState(account.id).enabled&&this.store.autoState(account.id).revision===state.revision;
        const task=(async()=>{try{
            const rows=await dialogs();if(!active())return;
            const checked=this.checked.get(account.id)??new Map<string,number>();this.checked.set(account.id,checked);
            for(const id of checked.keys())if(!rows.some(row=>row.id===id))checked.delete(id);
            const bindings=new Map(this.store.bindings(account.id).map(b=>[b.chatId,b]));
            const candidates=rows.filter(d=>{const b=bindings.get(d.id);return !b?.contactId && (b?b.enabled:bindings.size<100) && (b||telegramPhone(d.phone)) && (checked.get(d.id)??0)+300000<=this.now();}).sort((a,b)=>(checked.get(a.id)??0)-(checked.get(b.id)??0)).slice(0,10);
            let unresolved=0;
            if(candidates.length){const client=await this.clientForOwner(account.ownerId);for(const dialog of candidates){
                if(!active())return;const previous=this.store.bindings(account.id).find(b=>b.chatId===dialog.id);if(previous?.contactId||previous&&!previous.enabled)continue;
                const contact=previous ? await legacyContact(client,this.store,previous) : await uniqueContactByPhone(client,dialog.phone!);
                if(!active())return;const current=this.store.bindings(account.id).find(b=>b.chatId===dialog.id);
                if(current?.contactId||current&&!current.enabled||(!previous&&current))continue;
                if(contact){if(previous){if(current?.dealId!==previous.dealId)continue;this.store.attachContact(account.id,dialog.id,contact.id);}else{this.store.bindContact(account.id,dialog.id,dialog.title,contact.id,dialog.peer);this.store.recordAutoLink(account.id,dialog.id);}}
                else unresolved++;
                checked.set(dialog.id,this.now());
            }}
            if(active())this.store.autoResult(account.id,state.revision,new Date(this.now()).toISOString(),unresolved?'Для части диалогов не найден единственный контакт. Выберите контакт вручную.':'');
        }catch{if(active()){this.next.set(account.id,this.now()+300000);this.store.autoResult(account.id,state.revision,new Date(this.now()).toISOString(),'Не удалось проверить контакты CRM. Сбор уже привязанных диалогов продолжается. Повтор через 5 минут.');}}})().finally(()=>this.running.delete(account.id));
        this.running.set(account.id,task);return task;
    }
    reset(id:string):void{this.next.delete(id);this.checked.delete(id);}
    async close():Promise<void>{this.closed=true;await Promise.all(this.running.values());}
}
