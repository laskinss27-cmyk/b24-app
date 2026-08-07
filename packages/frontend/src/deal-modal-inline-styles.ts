import type { CSSProperties } from 'react';

export const splitOv: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(20,30,50,.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', zIndex: 1000, overflow: 'auto' };
export const splitCard: CSSProperties = { background: '#fff', borderRadius: 12, padding: 20, maxWidth: 560, width: '100%', boxShadow: '0 10px 40px rgba(0,0,0,.25)', color: '#1a2231' };
export const splitFld: CSSProperties = { padding: '6px 8px', border: '1px solid #cdd5e0', borderRadius: 6, fontSize: 14, color: '#1a2231' };
export const splitGhost: CSSProperties = { ...splitFld, cursor: 'pointer', background: '#fff' };
