import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramReadQueue } from './read-queue.js';
test('Telegram read queue spaces concurrent RPCs and stops queued work on FLOOD',async()=>{
 let now=1000;const starts:number[]=[],q=new TelegramReadQueue(3500,()=>now,async ms=>{now+=ms;});
 await Promise.all([1,2,3].map(()=>q.run(async()=>{starts.push(now);})));assert.deepEqual(starts,[1000,4500,8000]);
 let sent=0;const flood={errorMessage:'FLOOD',seconds:60};
 const results=await Promise.allSettled([q.run(async()=>{throw flood;}),q.run(async()=>{sent++;})]);assert.ok(results.every(r=>r.status==='rejected'&&r.reason===flood));assert.equal(sent,0);q.close();
});
test('Closing Telegram read queue cancels a waiting RPC before it reaches Telegram',async()=>{
 let waiting!:()=>void;const ready=new Promise<void>(r=>{waiting=r;});const q=new TelegramReadQueue(3500,()=>1000,async(_ms,signal)=>{waiting();await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed')),{once:true}));});
 await q.run(async()=>1);let sent=false;const next=q.run(async()=>{sent=true;});await ready;q.close();await assert.rejects(next);assert.equal(sent,false);await assert.rejects(q.run(async()=>1));
});
