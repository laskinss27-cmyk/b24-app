import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
export function receiverIdentity() {
    const path = resolve('release.json');
    if (!existsSync(path)) return { gitSha: null, gitTree: null };
    const body = JSON.parse(readFileSync(path, 'utf8')) as { gitSha: string; gitTree: string };
    if (!/^[a-f0-9]{40}$/.test(body.gitSha) || !/^[a-f0-9]{40}$/.test(body.gitTree)) throw Error('Invalid receiver release');
    return { gitSha: body.gitSha, gitTree: body.gitTree };
}
