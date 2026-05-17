import type { PivxBackend } from "./index";
import type { TxInfo, TxOutput } from "../types";

export interface ExplorerConfig {
  /**
   * Base URL of a BlockBook-compatible PIVX explorer.
   * Example: https://blockbook.pivx.org (no trailing slash).
   */
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

interface BlockBookVout {
  value: string; // satoshis as string
  n: number;
  addresses?: string[];
  isAddress?: boolean;
  hex?: string;
}

interface BlockBookTx {
  txid: string;
  confirmations: number;
  vout: BlockBookVout[];
}

export class ExplorerBackend implements PivxBackend {
  constructor(private readonly cfg: ExplorerConfig) {}

  async getTransaction(txid: string): Promise<TxInfo | null> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/api/v2/tx/${encodeURIComponent(txid)}`;
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`explorer ${url} returned ${res.status}`);
    const tx = (await res.json()) as BlockBookTx;
    return {
      txid: tx.txid,
      confirmations: tx.confirmations ?? 0,
      outputs: tx.vout.map(mapVout),
    };
  }
}

function mapVout(v: BlockBookVout): TxOutput {
  const opReturn = v.hex && v.hex.startsWith("6a") ? decodeOpReturnHex(v.hex) : null;
  if (opReturn !== null) {
    return { value: null, address: null, opReturnText: opReturn };
  }
  return {
    value: satsStringToPivString(v.value),
    address: v.addresses && v.addresses[0] ? v.addresses[0] : null,
    opReturnText: null,
  };
}

function satsStringToPivString(sats: string): string {
  // BlockBook reports satoshi-equivalents as a decimal string.
  const n = BigInt(sats);
  const whole = n / 100_000_000n;
  const frac = (n % 100_000_000n).toString().padStart(8, "0");
  return `${whole}.${frac}`;
}

function decodeOpReturnHex(scriptHex: string): string | null {
  // scriptHex: "6a" + push opcode/length + data
  // Common forms: 6a <1-75 length><data>, 6a 4c <length><data> (OP_PUSHDATA1), etc.
  let i = 2;
  let len: number;
  const next = parseInt(scriptHex.slice(i, i + 2), 16);
  if (Number.isNaN(next)) return null;
  if (next <= 0x4b) {
    len = next;
    i += 2;
  } else if (next === 0x4c) {
    len = parseInt(scriptHex.slice(i + 2, i + 4), 16);
    i += 4;
  } else if (next === 0x4d) {
    // little-endian uint16
    const b0 = parseInt(scriptHex.slice(i + 2, i + 4), 16);
    const b1 = parseInt(scriptHex.slice(i + 4, i + 6), 16);
    len = b0 | (b1 << 8);
    i += 6;
  } else {
    return null;
  }
  const dataHex = scriptHex.slice(i, i + len * 2);
  if (dataHex.length !== len * 2) return null;
  try {
    return Buffer.from(dataHex, "hex").toString("utf8");
  } catch {
    return null;
  }
}
