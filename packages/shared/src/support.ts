export const SUPPORT_STATUSES = ['new', 'in_progress', 'needs_details', 'needs_owner', 'resolved'] as const;
export type SupportStatus = typeof SUPPORT_STATUSES[number];
export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
	new: 'Зарегистрировано', in_progress: 'В работе', needs_details: 'Нужны подробности',
	needs_owner: 'Нужно решение Сергея', resolved: 'Решено',
};
export const SUPPORT_MAX_FILES = 3;
export const SUPPORT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export interface SupportUpload { name: string; mime: string; base64: string }
export interface SupportAttachment { id: number; name: string; mime: string; bytes: number }
export interface SupportMessage {
	id: number; author: { id: string; name: string }; role: 'manager' | 'owner' | 'assistant';
	text: string; createdAt: string; attachments: SupportAttachment[];
}
export interface SupportTicket {
	id: number; number: string; author: { id: string; name: string }; reference: string;
	context: string; description: string; expected: string; status: SupportStatus;
	createdAt: string; updatedAt: string; inputRevision: number; messages: SupportMessage[];
	delivery: 'sent' | 'pending' | 'attention';
}
export const supportNumber = (id: number): string => `SUP-${String(id).padStart(6, '0')}`;
