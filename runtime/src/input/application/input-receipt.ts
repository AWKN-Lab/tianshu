import {
  InputJsonReceiptPayloadSchema,
  ReceiptEnvelopeSchema,
  createAwknId,
  receiptPayloadHash,
  type ActorRef,
  type InputJsonReceiptPayload,
  type ReceiptEnvelope,
} from '../../contracts/public.js';

export interface BuildInputReceiptRequest {
  executionId: string;
  traceId: string;
  producer: ActorRef;
  payload: InputJsonReceiptPayload;
  createdAt: string;
  receiptId?: string;
}

export function buildInputJsonReceipt(request: BuildInputReceiptRequest): ReceiptEnvelope {
  const payload = InputJsonReceiptPayloadSchema.parse(request.payload);
  return ReceiptEnvelopeSchema.parse({
    schema: 'awkn-receipt-envelope/v1',
    receiptId: request.receiptId ?? createAwknId('receipt'),
    receiptType: 'INPUT',
    payloadSchema: payload.schema,
    executionId: request.executionId,
    traceId: request.traceId,
    aggregateType: 'input-json',
    aggregateId: payload.sourceHash,
    producer: request.producer,
    status: payload.status === 'ACCEPTED' ? 'SUCCESS' : 'FAILURE',
    payload,
    payloadHash: receiptPayloadHash(payload.schema, payload),
    artifactRefs: [],
    createdAt: request.createdAt,
  });
}
