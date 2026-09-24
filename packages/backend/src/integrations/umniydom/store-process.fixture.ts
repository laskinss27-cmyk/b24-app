import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { deliveryEnvelopeSchema } from './contract.js';
import { OrdersStore } from './store.js';

const payload = readFileSync(new URL('../../../../../docs/contracts/order-created.v1.example.json', import.meta.url), 'utf8');
const envelope = deliveryEnvelopeSchema.parse(JSON.parse(payload));
const store = new OrdersStore(process.argv[2]!, 'sandbox', envelope.sourceId);
const result = store.accept(envelope, payload, createHash('sha256').update(payload).digest('hex'));
process.stdout.write(result.ack.receiptId, () => {
	if (process.argv[3] !== 'crash-after-commit') store.close();
	process.exit(0);
});
