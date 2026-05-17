export type Network = "pivx-mainnet" | "pivx-testnet" | "pivx-regtest";

export type Scheme = "pivx-transparent" | "pivx-shield";

export interface PaymentRequirement {
  scheme: Scheme;
  network: Network;
  asset: "PIV";
  /** Decimal string, e.g. "0.01". */
  maxAmountRequired: string;
  /** Destination PIVX address. */
  payTo: string;
  /** Server-generated nonce. Client MUST embed this in an OP_RETURN. */
  nonce: string;
  /** Minimum confirmations before the payment is accepted. 0 = mempool ok. */
  minConfirmations: number;
  /** Seconds until the requirement expires. */
  maxTimeoutSeconds: number;
  /** The resource being paid for, e.g. "/api/weather". */
  resource: string;
  description?: string;
}

export interface PaymentRequiredEnvelope {
  x402Version: 1;
  accepts: PaymentRequirement[];
  error?: string;
}

export interface PaymentProof {
  x402Version: 1;
  scheme: Scheme;
  network: Network;
  payload: ProofPayload;
}

/** Same shape for transparent and shielded — txid is public either way. */
export interface ProofPayload {
  /** Broadcast txid of the payment. */
  txid: string;
  /** Echoed back from the requirement so the server can match. */
  nonce: string;
}

export type TransparentProofPayload = ProofPayload;
export type ShieldedProofPayload = ProofPayload;

export interface TxOutput {
  /** Amount in PIV as a decimal string. null for OP_RETURN. */
  value: string | null;
  /** Recipient address, or null for non-address outputs (OP_RETURN, multisig, etc.). */
  address: string | null;
  /** Decoded OP_RETURN data as a UTF-8 string, or null if not an OP_RETURN. */
  opReturnText: string | null;
}

export interface TxInfo {
  txid: string;
  confirmations: number;
  outputs: TxOutput[];
}

/** A shielded (Sapling) output visible to the holder of the relevant viewing key. */
export interface ShieldedOutput {
  /** Shielded address (ps1... on mainnet). */
  address: string;
  /** Amount in PIV as a decimal string. */
  value: string;
  /** Decoded memo as UTF-8 text. null if memo is not valid UTF-8. */
  memoText: string | null;
  /** True if this output is one we sent (visible via outgoing viewing key). */
  outgoing: boolean;
}

export interface ShieldedTxInfo {
  txid: string;
  confirmations: number;
  shieldedOutputs: ShieldedOutput[];
}

export interface VerificationResult {
  ok: boolean;
  /** Set when ok=false. Stable codes for clients to react to. */
  reason?:
    | "tx_not_found"
    | "insufficient_confirmations"
    | "wrong_recipient"
    | "insufficient_amount"
    | "missing_nonce"
    | "nonce_replayed"
    | "scheme_unsupported"
    | "network_mismatch"
    | "shielded_backend_unavailable";
  details?: string;
}
