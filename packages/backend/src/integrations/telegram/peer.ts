import { Api } from 'teleproto';
import bigInt from 'big-integer';
// Legacy user peers remain readable without rewriting encrypted storage.
export type TelegramPeer = { userId: string; accessHash: string } | { kind: 'group'; chatId: string } | { kind: 'supergroup'; channelId: string; accessHash: string };
export const isGroup = (id: string): boolean => /^(g|s):[1-9]\d*(?:-\d+)?$/.test(id);
export const dialogKind = (id: string): 'private' | 'group' => isGroup(id) ? 'group' : 'private';
export function peerKey(peer: Api.TypePeer): string {
    if (peer instanceof Api.PeerUser) return String(peer.userId);
    if (peer instanceof Api.PeerChat) return 'g:' + peer.chatId;
    return 's:' + peer.channelId;
}
export function storedPeerKey(peer: TelegramPeer): string {
    return 'userId' in peer ? peer.userId : peer.kind === 'group' ? 'g:' + peer.chatId : 's:' + peer.channelId;
}
export function inputPeer(peer: TelegramPeer): Api.TypeInputPeer {
    if ('userId' in peer) return new Api.InputPeerUser({ userId: bigInt(peer.userId), accessHash: bigInt(peer.accessHash) });
    return peer.kind === 'group' ? new Api.InputPeerChat({ chatId: bigInt(peer.chatId) }) : new Api.InputPeerChannel({ channelId: bigInt(peer.channelId), accessHash: bigInt(peer.accessHash) });
}
