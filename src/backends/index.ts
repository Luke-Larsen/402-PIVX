import type { ShieldedTxInfo, TxInfo } from "../types";

export interface PivxBackend {
  /** Returns the transaction, or null if not (yet) known to the backend. */
  getTransaction(txid: string): Promise<TxInfo | null>;
  /**
   * Decode the shielded portion of a transaction using viewing keys held by
   * this backend. Optional: explorer-only backends cannot implement this, since
   * shielded outputs are encrypted on-chain.
   */
  viewShieldedTransaction?(txid: string): Promise<ShieldedTxInfo | null>;
}

export { NodeRpcBackend } from "./node-rpc";
export type { NodeRpcConfig } from "./node-rpc";
export { ExplorerBackend } from "./explorer";
export type { ExplorerConfig } from "./explorer";
