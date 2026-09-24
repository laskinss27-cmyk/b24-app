export interface ReservationSqlResult {
	affectedRows?: number;
	insertId?: bigint | number | string;
}

export interface ReservationSqlConnection {
	query<T = unknown>(sql: string, values?: unknown[]): Promise<T>;
}

export interface AvailabilityKey {
	erpWarehouseName: string;
	itemCode: string;
}

export type ReservationCommandStatus = 'started' | 'applied' | 'failed' | 'pending_reconcile';

export interface BeginReservationCommandInput {
	idempotencyKey: string;
	commandType: string;
	requestHash: Buffer;
	actorId: string;
	reservationId?: bigint | number | string | null;
	reservationRequestId?: bigint | number | string | null;
	releaseRequestId?: bigint | number | string | null;
	correlationKey?: string | null;
	causationKey?: string | null;
}

export interface ReservationCommandRecord {
	id: bigint | number | string;
	requestHash: Buffer;
	status: ReservationCommandStatus;
	externalDoctype: string | null;
	externalDocumentName: string | null;
}

export interface BeginReservationCommandResult {
	disposition: 'start' | 'in_progress' | 'replay';
	command: ReservationCommandRecord;
}

function binaryCompare(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function normalizeAvailabilityKeys(keys: readonly AvailabilityKey[]): AvailabilityKey[] {
	const unique = new Map<string, AvailabilityKey>();
	for (const key of keys) {
		const erpWarehouseName = key.erpWarehouseName.trim();
		const itemCode = key.itemCode.trim();
		if (!erpWarehouseName || !itemCode) throw new Error('Availability key requires warehouse and item identities');
		const identity = `${Buffer.byteLength(erpWarehouseName, 'utf8')}:${erpWarehouseName}${Buffer.byteLength(itemCode, 'utf8')}:${itemCode}`;
		unique.set(identity, { erpWarehouseName, itemCode });
	}
	return [...unique.values()].sort((left, right) => (
		binaryCompare(left.erpWarehouseName, right.erpWarehouseName)
		|| binaryCompare(left.itemCode, right.itemCode)
	));
}

/** Must run inside the caller's SQL transaction. */
export async function lockAvailabilityKeys(
	connection: ReservationSqlConnection,
	input: readonly AvailabilityKey[],
): Promise<AvailabilityKey[]> {
	const keys = normalizeAvailabilityKeys(input);
	if (!keys.length) throw new Error('At least one availability key is required');
	const valuePlaceholders = keys.map(() => '(?, ?)').join(', ');
	const values = keys.flatMap((key) => [key.erpWarehouseName, key.itemCode]);
	await connection.query(
		`INSERT IGNORE INTO stock_availability_keys (erp_warehouse_name, item_code) VALUES ${valuePlaceholders}`,
		values,
	);
	const tuplePlaceholders = keys.map(() => '(?, ?)').join(', ');
	const rows = await connection.query<Array<Record<string, unknown>>>(`
		SELECT erp_warehouse_name, item_code
		FROM stock_availability_keys
		WHERE (erp_warehouse_name, item_code) IN (${tuplePlaceholders})
		ORDER BY erp_warehouse_name COLLATE utf8mb4_bin, item_code COLLATE utf8mb4_bin
		FOR UPDATE
	`, values);
	if (rows.length !== keys.length) throw new Error('Could not lock every availability key');
	return keys;
}

function validateCommandInput(input: BeginReservationCommandInput): void {
	if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 191) throw new Error('Invalid idempotency key');
	if (!input.commandType.trim() || input.commandType.length > 32) throw new Error('Invalid command type');
	if (!input.actorId.trim() || input.actorId.length > 191) throw new Error('Invalid command actor');
	if (input.requestHash.length !== 32) throw new Error('requestHash must contain 32 bytes');
}

function commandRecord(row: Record<string, unknown>): ReservationCommandRecord {
	const requestHash = row['request_hash'];
	if (!Buffer.isBuffer(requestHash) || requestHash.length !== 32) throw new Error('Stored reservation command hash is invalid');
	const status = String(row['status']) as ReservationCommandStatus;
	if (!['started', 'applied', 'failed', 'pending_reconcile'].includes(status)) {
		throw new Error(`Stored reservation command status is invalid: ${status}`);
	}
	return {
		id: row['id'] as bigint | number | string,
		requestHash,
		status,
		externalDoctype: row['external_doctype'] == null ? null : String(row['external_doctype']),
		externalDocumentName: row['external_document_name'] == null ? null : String(row['external_document_name']),
	};
}

/** Must run inside the caller's SQL transaction. */
export async function beginReservationCommand(
	connection: ReservationSqlConnection,
	input: BeginReservationCommandInput,
): Promise<BeginReservationCommandResult> {
	validateCommandInput(input);
	const inserted = await connection.query<ReservationSqlResult>(`
		INSERT IGNORE INTO stock_reservation_commands (
			idempotency_key, reservation_id, reservation_request_id, release_request_id,
			command_type, request_hash, status, actor_id, correlation_key, causation_key
		) VALUES (?, ?, ?, ?, ?, ?, 'started', ?, ?, ?)
	`, [
		input.idempotencyKey,
		input.reservationId ?? null,
		input.reservationRequestId ?? null,
		input.releaseRequestId ?? null,
		input.commandType,
		input.requestHash,
		input.actorId,
		input.correlationKey ?? null,
		input.causationKey ?? null,
	]);
	const rows = await connection.query<Array<Record<string, unknown>>>(`
		SELECT id, request_hash, status, external_doctype, external_document_name
		FROM stock_reservation_commands
		WHERE idempotency_key = ?
		FOR UPDATE
	`, [input.idempotencyKey]);
	if (rows.length !== 1) throw new Error('Reservation command was not registered');
	const command = commandRecord(rows[0]!);
	if (!command.requestHash.equals(input.requestHash)) {
		throw new Error('Idempotency key conflicts with a different request hash');
	}
	if (Number(inserted.affectedRows ?? 0) === 1) return { disposition: 'start', command };
	return {
		disposition: command.status === 'started' || command.status === 'pending_reconcile' ? 'in_progress' : 'replay',
		command,
	};
}

export async function finishReservationCommand(
	connection: ReservationSqlConnection,
	commandId: bigint | number | string,
	status: Exclude<ReservationCommandStatus, 'started'>,
	external?: { doctype: string; documentName: string } | null,
): Promise<void> {
	const finishedAt = status === 'pending_reconcile' ? null : new Date();
	const result = await connection.query<ReservationSqlResult>(`
		UPDATE stock_reservation_commands
		SET status = ?, external_doctype = ?, external_document_name = ?, finished_at = ?
		WHERE id = ? AND status IN ('started', 'pending_reconcile')
	`, [status, external?.doctype ?? null, external?.documentName ?? null, finishedAt, commandId]);
	if (Number(result.affectedRows ?? 0) !== 1) throw new Error('Reservation command transition lost optimistic ownership');
}
