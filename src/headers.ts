import type { PaymentProof, PaymentRequiredEnvelope } from "./types";

export const HEADER_PAYMENT_REQUIRED = "X-Payment-Required";
export const HEADER_PAYMENT = "X-Payment";

function b64encode(json: unknown): string {
  return Buffer.from(JSON.stringify(json), "utf8").toString("base64");
}

function b64decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

export function encodeRequirements(env: PaymentRequiredEnvelope): string {
  return b64encode(env);
}

export function decodeRequirements(header: string): PaymentRequiredEnvelope {
  return b64decode<PaymentRequiredEnvelope>(header);
}

export function encodeProof(proof: PaymentProof): string {
  return b64encode(proof);
}

export function decodeProof(header: string): PaymentProof {
  return b64decode<PaymentProof>(header);
}
