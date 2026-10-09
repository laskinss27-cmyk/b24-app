export const HISTORY_WAIT_MS=90000;
export class HistoryMonitor {
  constructor(now=()=>Date.now()) {this.now=now;this.startedAt=0;this.frames=0;this.expandedChats=0;this.totalMessages=0;this.notifications=[];this.failures=[];this.requests=new Map();}
  connected(model){this.startedAt=this.now();if(model)this.expandedChats=[...model.chats.values()].filter(chat=>chat.messages.size>1).length;}
  request(id,before){this.requests.set(id,{at:this.now(),before,state:'pending',added:0});}
  frame(type,messages,model){
    this.frames++;this.totalMessages+=messages.length;
    this.expandedChats=[...model.chats.values()].filter(chat=>chat.messages.size>1).length;
    for(const [id,request] of this.requests){
      const chat=model.chats.get(model.canonical(id));if(!chat)continue;
      const incoming=new Set(messages.filter(message=>model.canonical(message.key?.remoteJid)===model.canonical(id)).map(message=>String(message.key.fromMe===true)+':'+message.key.id));
      const extra=[...incoming].filter(key=>chat.messages.has(key)&&!request.before.has(key)).length;
      if(extra>0){request.state='received';request.added=extra;}
    }
  }
  requestState(id){const value=this.requests.get(id);if(!value)return null;return {state:value.state==='pending'&&this.now()-value.at>=HISTORY_WAIT_MS?'timeout':value.state,added:value.added};}
  failed(id){const value=this.requests.get(id);if(value)value.state='failed';}
  summary(){return {frames:this.frames,expandedChats:this.expandedChats,messagesInFrames:this.totalMessages,notifications:this.notifications.slice(-10),failures:this.failures.slice(-5),requests:[...this.requests].map(([id])=>({id,...this.requestState(id)})),initialTimeout:this.startedAt>0&&this.now()-this.startedAt>=HISTORY_WAIT_MS&&this.expandedChats===0};}
  logger(){
    const log={level:'trace',child:()=>log};
    for(const level of ['trace','debug','info','warn','error','fatal'])log[level]=(...args)=>{
      const data=typeof args[0]==='object'&&args[0]!==null?args[0]:{},msg=args.find(x=>typeof x==='string')||'';
      if(msg==='got history notification'){
        const h=data.histNotification||{};
        this.notifications.push({type:Number.isFinite(h.syncType)?h.syncType:null,accepted:data.process===true,inline:!!h.initialHistBootstrapInlinePayload,at:this.now()});this.notifications=this.notifications.slice(-10);
      }
      if(['warn','error','fatal'].includes(level)){
        const error=data.err||data.error,code=error?.code||error?.cause?.code;
        this.failures.push({kind:/history/i.test(msg)?'history':/decrypt|message/i.test(msg)?'message':/connection|socket|stream|network/i.test(msg)?'network':'other',code:typeof code==='string'&&/^[A-Z_]{2,35}$/.test(code)?code:null,status:Number.isInteger(error?.output?.statusCode)?error.output.statusCode:null,at:this.now()});this.failures=this.failures.slice(-5);
      }
    };
    return log;
  }
}
