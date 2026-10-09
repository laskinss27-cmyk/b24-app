import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

// Local, authenticated encryption. The key and ciphertext are in separately ignored directories.
export class EncryptedSession {
  constructor(file, keyFile, codec = JSON) { this.file = file; this.keyFile = keyFile; this.codec = codec; this.closed = false; }
  key(create = false) {
    if (!existsSync(this.keyFile)) {
      if (!create || existsSync(this.file)) throw Error('Session encryption key is missing');
      mkdirSync(dirname(this.keyFile), {recursive:true,mode:0o700});
      writeFileSync(this.keyFile,randomBytes(32),{flag:'wx',mode:0o600});
    }
    const key = readFileSync(this.keyFile); if (key.length !== 32) throw Error('Invalid session key'); return key;
  }
  load() {
    if (!existsSync(this.file)) return null;
    const bytes = readFileSync(this.file); if (bytes.length < 32 || bytes.subarray(0,4).toString() !== 'WAP1') throw Error('Invalid session envelope');
    const decipher = createDecipheriv('aes-256-gcm',this.key(),bytes.subarray(4,16)); decipher.setAAD(Buffer.from('b24-whatsapp-pilot-v1')); decipher.setAuthTag(bytes.subarray(16,32));
    return this.codec.parse(Buffer.concat([decipher.update(bytes.subarray(32)),decipher.final()]).toString('utf8'));
  }
  save(value) {
    if (this.closed) return;
    const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(true),nonce);cipher.setAAD(Buffer.from('b24-whatsapp-pilot-v1'));
    const ciphertext=Buffer.concat([cipher.update(this.codec.stringify(value),'utf8'),cipher.final()]);
    mkdirSync(dirname(this.file),{recursive:true,mode:0o700});
    const temp=this.file+'.next'; writeFileSync(temp,Buffer.concat([Buffer.from('WAP1'),nonce,cipher.getAuthTag(),ciphertext]),{mode:0o600});renameSync(temp,this.file);
  }
  forget() { this.closed=true; for(const path of [this.file,this.file+'.next']) {try{unlinkSync(path)}catch(error){if(error.code!=='ENOENT')throw error}} }
}
