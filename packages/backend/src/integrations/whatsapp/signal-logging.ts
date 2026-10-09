import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
// libsignal 6.0.0 dumps full session keys via console, outside Baileys' logger.
// Preserve its tiny state transitions but omit secret-bearing logging. Fail closed on upstream changes.
let applied = false;
export function quietSignalSessionRecords(): void {
    if (applied)
        return;
    const require = createRequire(import.meta.url), fromBaileys = createRequire(require.resolve('@whiskeysockets/baileys'));
    const { SessionRecord } = fromBaileys('libsignal') as {
        SessionRecord: {
            prototype: {
                closeSession: (s: Session) => void;
                openSession: (s: Session) => void;
                isClosed: (s: Session) => boolean;
                removeOldSessions: () => void;
                sessions: Record<string,Session>;
            };
        };
    };
    const p = SessionRecord.prototype, hash = (f: Function) => createHash('sha256').update(f.toString().replace(/\s+/g, ' ')).digest('hex');
    if (hash(p.removeOldSessions) !== 'e8cd599098b97fd8153f335282e8fe5698ea391473cf18dd3c1b3a487d019c8e' || hash(p.closeSession) !== '27bc7a4e88299cfe87c81bd97284a7958f21539fa21094187206e58682ed96b5' || hash(p.openSession) !== '8bf1c89aaad7fad8603724387c9400db3898e616472c94509a84e57c2120b70e')
        throw Error('Review libsignal logging before enabling WhatsApp');
    p.closeSession = function (session) { if (!this.isClosed(session))
        session.indexInfo.closed = Date.now(); };
    p.openSession = function (session) { session.indexInfo.closed = -1; };
    p.removeOldSessions = function () {
        // libsignal 6.0.0 CLOSED_SESSIONS_MAX, preserved exactly.
        while (Object.keys(this.sessions).length > 40) {
            let oldestKey: string | undefined, oldest: Session | undefined;
            for (const [key,session] of Object.entries(this.sessions)) {
                if (session.indexInfo.closed !== -1 && (!oldest || session.indexInfo.closed < oldest.indexInfo.closed)) { oldestKey=key; oldest=session; }
            }
            if (oldestKey) delete this.sessions[oldestKey];
            else throw Error('Corrupt sessions object');
        }
    };
    applied = true;
}
interface Session {
    indexInfo: {
        closed: number;
    };
}
