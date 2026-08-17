export const transferNumberLabel = (transfer: { id: number }): string => `№${transfer.id}`;

export const transferNumberSearchValues = (transfer: { id: number }): Array<string | number> => [
	transfer.id,
	`№${transfer.id}`,
	`#${transfer.id}`,
];
