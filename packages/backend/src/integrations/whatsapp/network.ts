import { Agent } from 'undici';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { connect as tlsConnect } from 'node:tls';
/** Same SOCKS tunnel for WebSocket and native-fetch media/history; no OS/global proxy changes. */
export function whatsappNetwork(proxy?: string): {
    agent?: SocksProxyAgent;
    options: RequestInit;
    close: () => Promise<void>;
} {
    if (!proxy)
        return { options: {}, close: async () => { } };
    const url = new URL(proxy), agent = new SocksProxyAgent(proxy);
    const dispatcher = new Agent({ connect: (options, callback) => {
            const host = String(options.hostname), port = Number(options.port || 443);
            void SocksClient.createConnection({ proxy: { host: url.hostname, port: Number(url.port), type: 5, ...(url.username ? { userId: decodeURIComponent(url.username), password: decodeURIComponent(url.password) } : {}) }, command: 'connect', destination: { host, port }, timeout: 15000 }).then(({ socket }) => {
                if (options.protocol === 'https:') {
                    const tls = tlsConnect({ socket, servername: host, rejectUnauthorized: true });
                    let done = false;
                    const finish = (error: Error | null) => { if (done)
                        return; done = true; if (error)
                        callback(error, null);
                    else
                        callback(null, tls); };
                    tls.once('secureConnect', () => finish(null));
                    tls.once('error', finish);
                }
                else
                    callback(null, socket);
            }).catch(e => callback(e, null));
        } });
    return { agent, options: { dispatcher } as RequestInit, close: async () => { agent.destroy(); await dispatcher.destroy(); } };
}
