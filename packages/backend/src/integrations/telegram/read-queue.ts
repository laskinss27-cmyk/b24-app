import { setTimeout as delay } from 'node:timers/promises';
/** One queue per Telegram account. A rate-limit response fences already queued requests. */
export class TelegramReadQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private next = 0;
    private blocked: unknown = null;
    private abort = new AbortController();
    constructor(private interval = 3500, private now = Date.now, private wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal })) {}
    run<T>(read: () => Promise<T>): Promise<T> {
        const task = this.tail.catch(() => {}).then(async () => {
            this.abort.signal.throwIfAborted(); if (this.blocked) throw this.blocked;
            const wait = this.next - this.now(); if (wait > 0) await this.wait(wait, this.abort.signal);
            this.abort.signal.throwIfAborted(); if (this.blocked) throw this.blocked;
            this.next = this.now() + this.interval;
            try { return await read(); } catch (error) {
                if (/^FLOOD/.test(String((error as { errorMessage?: string })?.errorMessage ?? ''))) this.blocked = error;
                throw error;
            }
        });
        this.tail = task; return task;
    }
    close(): void { this.abort.abort(); }
}
