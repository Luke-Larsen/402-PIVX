import type { PivxBackend } from "./index";
import type { ShieldedOutput, ShieldedTxInfo, TxInfo, TxOutput } from "../types";

export interface NodeRpcConfig {
  /** e.g. http://127.0.0.1:51473 */
  url: string;
  username?: string;
  password?: string;
  /** Optional fetch override (for tests). */
  fetchImpl?: typeof fetch;
}

interface RpcVout {
  value: number;
  n: number;
  scriptPubKey: {
    asm: string;
    hex: string;
    type?: string;
    addresses?: string[];
    address?: string;
  };
}

interface GetRawTransactionResult {
  txid: string;
  confirmations?: number;
  vout: RpcVout[];
}

/**
 * Shape returned by pivxd's `viewshieldtransaction` RPC. Fields are decoded
 * using the viewing keys present in the node's wallet, so only outputs the
 * node can "see" appear here. Note: the method is `viewshieldtransaction`
 * (without "ed") and the field is `outputs` (not `shielded_outputs`) — this
 * differs from older Zcash RPC names.
 *
 * The RPC does NOT return `confirmations`; we fetch that via getrawtransaction.
 */
interface ViewShieldTransactionResult {
  txid: string;
  outputs?: Array<{
    address: string;
    value?: number;
    valueSat?: number;
    /** Hex-encoded memo bytes (PIVX/Zcash convention). */
    memo?: string;
    /** Only present when memo bytes are valid UTF-8. */
    memoStr?: string;
    outgoing?: boolean;
  }>;
}

export class NodeRpcBackend implements PivxBackend {
  constructor(private readonly cfg: NodeRpcConfig) {}

  async getTransaction(txid: string): Promise<TxInfo | null> {
    let raw: GetRawTransactionResult | null;
    try {
      raw = await this.call<GetRawTransactionResult>("getrawtransaction", [txid, true]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/No such mempool|No information available|-5/i.test(msg)) return null;
      throw err;
    }
    if (!raw) return null;

    const outputs: TxOutput[] = raw.vout.map((v) => {
      const isOpReturn = v.scriptPubKey.asm?.startsWith("OP_RETURN");
      if (isOpReturn) {
        return {
          value: null,
          address: null,
          opReturnText: decodeOpReturnAsm(v.scriptPubKey.asm),
        };
      }
      const address =
        v.scriptPubKey.address ??
        (v.scriptPubKey.addresses && v.scriptPubKey.addresses[0]) ??
        null;
      return {
        value: typeof v.value === "number" ? v.value.toFixed(8) : String(v.value),
        address,
        opReturnText: null,
      };
    });

    return {
      txid: raw.txid,
      confirmations: raw.confirmations ?? 0,
      outputs,
    };
  }

  async viewShieldedTransaction(txid: string): Promise<ShieldedTxInfo | null> {
    let raw: ViewShieldTransactionResult | null;
    try {
      raw = await this.call<ViewShieldTransactionResult>("viewshieldtransaction", [txid]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // -5: not in wallet (no viewing key for any output). Treat as "not visible".
      // -1: txid not found. Either way the verifier should see "tx_not_found".
      if (/No such mempool|No information available|-5|-1/i.test(msg)) return null;
      throw err;
    }
    if (!raw) return null;

    // viewshieldtransaction doesn't return confirmations; getrawtransaction does
    // and works for any chain tx (no wallet required).
    let confirmations = 0;
    try {
      const chain = await this.call<GetRawTransactionResult>("getrawtransaction", [txid, true]);
      confirmations = chain?.confirmations ?? 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/No such mempool|No information available|-5/i.test(msg)) throw err;
      // tx not yet on the chain or in mempool — treat as 0 confirmations.
    }

    const shieldedOutputs: ShieldedOutput[] = (raw.outputs ?? []).map((o) => ({
      address: o.address,
      value: typeof o.value === "number"
        ? o.value.toFixed(8)
        : typeof o.valueSat === "number"
          ? satsNumToPivStr(o.valueSat)
          : "0.00000000",
      memoText: o.memoStr ?? decodeMemoHex(o.memo),
      outgoing: o.outgoing === true,
    }));

    return {
      txid: raw.txid,
      confirmations,
      shieldedOutputs,
    };
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.username || this.cfg.password) {
      const token = Buffer.from(
        `${this.cfg.username ?? ""}:${this.cfg.password ?? ""}`,
      ).toString("base64");
      headers["authorization"] = `Basic ${token}`;
    }
    const res = await fetchImpl(this.cfg.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "1.0", id: "pivx402", method, params }),
    });
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new Error(`pivxd rpc ${method}: ${body.error.message}`);
    return body.result as T;
  }
}

function satsNumToPivStr(sats: number): string {
  const whole = Math.trunc(sats / 1e8);
  const frac = (sats - whole * 1e8).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

function decodeMemoHex(memo: string | undefined): string | null {
  if (!memo) return null;
  if (!/^[0-9a-fA-F]*$/.test(memo) || memo.length % 2 !== 0) return null;
  try {
    // Sapling memos are 512 bytes padded with 0x00; strip trailing nulls.
    const buf = Buffer.from(memo, "hex");
    let end = buf.length;
    while (end > 0 && buf[end - 1] === 0x00) end--;
    return buf.subarray(0, end).toString("utf8");
  } catch {
    return null;
  }
}

function decodeOpReturnAsm(asm: string): string | null {
  // asm looks like "OP_RETURN <hex>" or "OP_RETURN -1234" for numeric pushes.
  const rest = asm.slice("OP_RETURN".length).trim();
  if (!rest) return "";
  // Take the first whitespace-delimited token; PIVX's OP_RETURN typically holds one push.
  const token = rest.split(/\s+/)[0];
  if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0) {
    try {
      return Buffer.from(token, "hex").toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}
