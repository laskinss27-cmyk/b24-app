import type { AccessV3Draft, AccessV3Preview, AccessV3Response } from '@b24-app/shared';
import { bx24Auth } from './bitrix-auth.js';

export async function accessV3Request(action: 'load', data?: Record<string, unknown>): Promise<AccessV3Response>;
export async function accessV3Request(action: 'preview', data: Record<string, unknown>): Promise<AccessV3Preview>;
export async function accessV3Request(action: 'save', data: Record<string, unknown>): Promise<AccessV3Response>;
export async function accessV3Request(action: string, data: Record<string, unknown> = {}): Promise<AccessV3Response | AccessV3Preview> {
	const response = await fetch(`/api/access-control/v3/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...bx24Auth(), ...data }) });
	const result = await response.json();
	if (!response.ok || !result.ok || result.enforcement !== false) throw new Error(result.error ?? 'Не удалось безопасно открыть черновик прав');
	return result;
}

export function accessV3SaveInput(draft: AccessV3Draft, fingerprint: string): Record<string, unknown> {
	return { revision: draft.revision, directoryFingerprint: fingerprint, rules: { departments: draft.departments, employees: draft.employees } };
}
