import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as httpServer} from 'node:http';
import {createServer as netServer,connect,type Socket} from 'node:net';
import {once} from 'node:events';
import {whatsappNetwork} from './network.js';

test('Native Node fetch uses the SOCKS dispatcher without replacing global fetch, preserves remote DNS and cancels requests',async()=>{
 const native=globalThis.fetch,sockets=new Set<Socket>(),targets:string[]=[];
 const http=httpServer((req,res)=>{if(req.url==='/slow')return;res.setHeader('Content-Type','text/plain');res.end('WhatsApp transport probe');});
 http.listen(0,'127.0.0.1');await once(http,'listening');const port=(http.address() as {port:number}).port;
 const proxy=netServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let greeting=true,buffer=Buffer.alloc(0);
  const read=(chunk:Buffer)=>{buffer=Buffer.concat([buffer,chunk]);
   if(greeting){if(buffer.length<2||buffer.length<2+buffer[1]!)return;buffer=buffer.subarray(2+buffer[1]!);greeting=false;socket.write(Buffer.from([5,0]));}
   if(buffer.length<5)return;assert.equal(buffer[3],3);const length=buffer[4]!;if(buffer.length<7+length)return;
   targets.push(buffer.subarray(5,5+length).toString());assert.equal(buffer.readUInt16BE(5+length),port);socket.off('data',read);
   const remote=connect(port,'127.0.0.1',()=>{socket.write(Buffer.from([5,0,0,1,127,0,0,1,0,0]));remote.pipe(socket);socket.pipe(remote);});
   sockets.add(remote);remote.on('close',()=>sockets.delete(remote));socket.on('error',()=>remote.destroy());remote.on('error',()=>socket.destroy());
  };socket.on('data',read);
 });proxy.listen(0,'127.0.0.1');await once(proxy,'listening');const network=whatsappNetwork('socks5h://127.0.0.1:'+(proxy.address() as {port:number}).port);
 try{const response=await fetch('http://wa-test.invalid:'+port,{...network.options,signal:AbortSignal.timeout(5000)});assert.equal(await response.text(),'WhatsApp transport probe');assert.deepEqual(targets,['wa-test.invalid']);assert.equal(globalThis.fetch,native);await assert.rejects(fetch('http://wa-test.invalid:'+port+'/slow',{...network.options,signal:AbortSignal.timeout(100)}),/abort|timeout/i);}finally{await network.close();for(const s of sockets)s.destroy();http.closeAllConnections();await Promise.all([new Promise<void>(r=>http.close(()=>r())),new Promise<void>(r=>proxy.close(()=>r()))]);}
});
