#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  decodeRequirements,
  encodeProof,
  HEADER_PAYMENT,
  HEADER_PAYMENT_REQUIRED,
} from "../src/headers";
import type { PaymentProof, PaymentRequirement } from "../src/types";

interface Opts {
  url: string;
  pivxCli: string;
  pivxTx: string;
  datadir?: string;
  network: "mainnet" | "testnet" | "regtest";
  mineBlocks: number;
  feeRate: string;
  out?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Opts {
  const opts: Opts = {
    url: "",
    pivxCli: process.env.PIVX_CLI ?? `${process.env.PIVX_BIN_DIR ?? ""}/pivx-cli`.replace(/^\//, "/"),
    pivxTx: process.env.PIVX_TX ?? `${process.env.PIVX_BIN_DIR ?? ""}/pivx-tx`.replace(/^\//, "/"),
    datadir: process.env.PIVX_DATADIR,
    network: (process.env.PIVX_NETWORK as Opts["network"]) ?? "regtest",
    mineBlocks: Number(process.env.MINE_BLOCKS ?? 1),
    feeRate: process.env.FEE_RATE ?? "0.001",
    verbose: false,
  };
  // If PIVX_BIN_DIR wasn't set, fall back to bare names (PATH lookup).
  if (!process.env.PIVX_BIN_DIR) {
    if (!process.env.PIVX_CLI) opts.pivxCli = "pivx-cli";
    if (!process.env.PIVX_TX) opts.pivxTx = "pivx-tx";
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    switch (a) {
      case "--pivx-cli": opts.pivxCli = v(); break;
      case "--pivx-tx": opts.pivxTx = v(); break;
      case "--datadir": opts.datadir = v(); break;
      case "--network": opts.network = v() as Opts["network"]; break;
      case "--mine-blocks": opts.mineBlocks = Number(v()); break;
      case "--feeRate": case "--fee-rate": opts.feeRate = v(); break;
      case "--out": opts.out = v(); break;
      case "-v": case "--verbose": opts.verbose = true; break;
      case "-h": case "--help": usage(); process.exit(0);
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          usage();
          process.exit(2);
        }
        opts.url = a;
    }
  }
  if (!opts.url) {
    usage();
    process.exit(2);
  }
  return opts;
}

function usage(): void {
  console.error(`Usage: pay-cli [options] <url>

Pays a 402-gated PIVX endpoint and writes the resource body to stdout.

Options:
  --pivx-cli <path>     Path to pivx-cli (default: $PIVX_BIN_DIR/pivx-cli or PATH)
  --pivx-tx  <path>     Path to pivx-tx
  --datadir  <path>     Datadir passed to pivx-cli
  --network  <net>      regtest | testnet | mainnet (default: regtest)
  --mine-blocks <n>     After broadcasting, mine N blocks (regtest convenience). Default: 1
  --fee-rate <piv/kB>   feeRate for fundrawtransaction. Default: 0.001
  --out <file>          Write the resource body to this file instead of stdout
  -v, --verbose         Log progress to stderr
  -h, --help            Show this help

Env vars: PIVX_BIN_DIR, PIVX_CLI, PIVX_TX, PIVX_DATADIR, PIVX_NETWORK,
          MINE_BLOCKS, FEE_RATE
`);
}

function cli(opts: Opts, ...args: string[]): string {
  const all: string[] = [];
  if (opts.datadir) all.push(`-datadir=${opts.datadir}`);
  if (opts.network === "regtest") all.push("-regtest");
  else if (opts.network === "testnet") all.push("-testnet");
  all.push(...args);
  try {
    return execFileSync(opts.pivxCli, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    throw new Error(`pivx-cli ${args[0]} failed: ${stderr || e.message}`);
  }
}

function tx(opts: Opts, ...args: string[]): string {
  const all: string[] = [];
  if (opts.network === "regtest") all.push("-regtest");
  else if (opts.network === "testnet") all.push("-testnet");
  all.push(...args);
  try {
    return execFileSync(opts.pivxTx, all, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer | string; message?: string };
    const stderr = typeof e.stderr === "string" ? e.stderr : e.stderr?.toString() ?? "";
    throw new Error(`pivx-tx failed: ${stderr || e.message}`);
  }
}

function log(opts: Opts, msg: string): void {
  if (opts.verbose) console.error(`[pay-cli] ${msg}`);
}

async function fetchRequirement(url: string): Promise<{ requirement: PaymentRequirement; cookies: string }> {
  const res = await fetch(url);
  if (res.status !== 402) {
    throw new Error(`expected 402 from ${url}, got ${res.status}`);
  }
  const header = res.headers.get(HEADER_PAYMENT_REQUIRED.toLowerCase());
  if (!header) throw new Error(`server returned 402 with no ${HEADER_PAYMENT_REQUIRED} header`);
  const envelope = decodeRequirements(header);
  const requirement = envelope.accepts[0];
  if (!requirement) throw new Error("envelope had no payment options");
  // Drain the body so the connection can be reused.
  await res.text();
  return { requirement, cookies: res.headers.get("set-cookie") ?? "" };
}

function payTransparent(opts: Opts, req: PaymentRequirement): string {
  // Preflight: a transparent payment must be funded from transparent UTXOs.
  // fundrawtransaction can't see the shielded pool, so it would just say
  // "Insufficient funds" without hinting at the actual problem. Detect the
  // common "wallet only has shielded balance" case and surface the workflow.
  const price = Number(req.maxAmountRequired);
  let transparent = NaN;
  try { transparent = Number(cli(opts, "getbalance")); } catch { /* leave NaN; skip preflight */ }
  if (Number.isFinite(transparent) && transparent < price) {
    let shielded = 0;
    try { shielded = Number(cli(opts, "getshieldbalance")); } catch { /* ignore */ }
    // Sapling sends cost ~0.014 PIV in fees; require headroom so the suggested
    // de-shield won't immediately hit "Insufficient shielded funds".
    const SAPLING_FEE_BUDGET = 0.02;
    if (shielded >= price + SAPLING_FEE_BUDGET) {
      // price + a little headroom so the subsequent transparent tx has room for its fee.
      const target = (price + 0.0005).toFixed(8);
      throw new Error(
        `wallet has ${transparent} PIV transparent, endpoint requires ${price} PIV pivx-transparent.\n` +
        `You have ${shielded} PIV shielded, but shielded funds cannot pay a transparent x402 endpoint\n` +
        `in one tx (PIVX Sapling sends have no OP_RETURN). De-shield first:\n` +
        `  pivx-cli shieldsendmany "from_shield" '[{"address":"D<your-own-addr>","amount":${target}}]' 1\n` +
        `Wait one confirmation, then re-run pay-cli.`,
      );
    }
    // Otherwise (both balances empty, shielded too low to cover its own fee,
    // or some other shortfall) let fundrawtransaction produce its own error.
  }

  // 1. raw tx with just the recipient output
  log(opts, `createrawtransaction -> ${req.payTo} ${req.maxAmountRequired}`);
  const raw = cli(opts, "createrawtransaction", "[]", JSON.stringify({ [req.payTo]: Number(req.maxAmountRequired) }));

  // 2. fundrawtransaction with feeRate headroom for the splice
  log(opts, `fundrawtransaction feeRate=${opts.feeRate}`);
  const funded = JSON.parse(cli(opts, "fundrawtransaction", raw, JSON.stringify({ feeRate: Number(opts.feeRate) }))).hex;

  // 3. splice in OP_RETURN with the nonce as a literal byte push
  //    pivx-tx parses single-quoted ASCII as an OP_PUSHBYTES literal.
  log(opts, `pivx-tx outscript=0:OP_RETURN '${req.nonce}'`);
  const withOpReturn = tx(opts, funded, `outscript=0:OP_RETURN '${req.nonce}'`);

  // 4. sign
  log(opts, `signrawtransaction`);
  const signed = JSON.parse(cli(opts, "signrawtransaction", withOpReturn));
  if (!signed.complete) throw new Error(`sign incomplete: ${JSON.stringify(signed.errors ?? signed)}`);

  // 5. broadcast
  const txid = cli(opts, "sendrawtransaction", signed.hex);
  log(opts, `broadcast txid=${txid}`);
  return txid;
}

function payShielded(opts: Opts, req: PaymentRequirement): string {
  // PIVX's shieldsendmany takes the memo as a literal byte-string, NOT hex.
  // Pass the nonce as plain text; viewshieldtransaction returns it via memoStr.
  const out = [{ address: req.payTo, amount: Number(req.maxAmountRequired), memo: req.nonce }];
  // Spend from the shielded pool. PIVX accepts "from_transparent" | "from_shield"
  // | "from_trans_cold" or a specific source address — there is no "from_any".
  // Override with PIVX_SHIELD_FROM (e.g. "from_transparent" to shield-and-pay
  // in one tx) if you don't already hold balance in the shield pool.
  const from = process.env.PIVX_SHIELD_FROM ?? "from_shield";
  log(opts, `shieldsendmany ${from} memo=${req.nonce}`);
  return cli(opts, "shieldsendmany", from, JSON.stringify(out), "1");
}

function mineIfRegtest(opts: Opts, blocks: number): void {
  if (opts.network !== "regtest" || blocks <= 0) return;
  // Need any address to mine to; reuse a fresh one.
  const addr = cli(opts, "getnewaddress");
  log(opts, `generatetoaddress ${blocks} -> ${addr}`);
  cli(opts, "generatetoaddress", String(blocks), addr);
}

async function submitProof(url: string, req: PaymentRequirement, txid: string): Promise<Response> {
  const proof: PaymentProof = {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    payload: { txid, nonce: req.nonce },
  };
  return fetch(url, { headers: { [HEADER_PAYMENT]: encodeProof(proof) } });
}

// HTTP statuses that mean "upstream couldn't respond in time" — retry the same proof.
const RETRYABLE_HTTP_STATUSES = new Set([408, 502, 503, 504, 522, 524]);
// 402 error reasons that resolve by waiting (tx propagates, block mines) — same proof works.
// Anything else (insufficient_amount, wrong_recipient, nonce_replayed, ...) needs a new payment.
const RETRYABLE_402_ERRORS = ["tx_not_found", "insufficient_confirmations"];

function parse402Error(body: string): string | undefined {
  try { return (JSON.parse(body) as { error?: string }).error; } catch { return undefined; }
}

function isRetryable(status: number, body: string): boolean {
  if (RETRYABLE_HTTP_STATUSES.has(status)) return true;
  if (status === 402) {
    const err = parse402Error(body) ?? "";
    return RETRYABLE_402_ERRORS.some((r) => err.startsWith(r));
  }
  return false;
}

async function submitProofWithRetry(
  opts: Opts,
  url: string,
  req: PaymentRequirement,
  txid: string,
): Promise<{ status: number; body: Buffer; contentType: string | null }> {
  const deadline = Date.now() + Math.max(req.maxTimeoutSeconds, 60) * 1000;
  const delays = [5, 10, 20, 30];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await submitProof(url, req, txid);
    } catch (err) {
      // Network-level failure (DNS, reset, etc.) — treat like a retryable upstream error.
      if (Date.now() >= deadline) throw err;
      const wait = delays[Math.min(attempt, delays.length - 1)];
      log(opts, `attempt ${attempt + 1} network error (${(err as Error).message}), retrying in ${wait}s`);
      await sleep(wait * 1000);
      continue;
    }
    const body = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type");
    if (res.status === 200) return { status: res.status, body, contentType };

    const text = body.toString("utf8");
    if (!isRetryable(res.status, text) || Date.now() >= deadline) {
      return { status: res.status, body, contentType };
    }
    const wait = delays[Math.min(attempt, delays.length - 1)];
    const why = res.status === 402 ? `402 ${parse402Error(text) ?? "?"}` : `HTTP ${res.status}`;
    log(opts, `attempt ${attempt + 1} got ${why}, retrying in ${wait}s`);
    await sleep(wait * 1000);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  log(opts, `GET ${opts.url}`);
  const { requirement } = await fetchRequirement(opts.url);
  log(opts, `requires ${requirement.maxAmountRequired} PIV ${requirement.scheme} -> ${requirement.payTo}`);
  log(opts, `nonce=${requirement.nonce}`);

  let txid: string;
  if (requirement.scheme === "pivx-transparent") {
    if (process.env.PIVX_SHIELD_FROM) {
      // shield->transparent payments cannot embed the nonce: PIVX's shieldsendmany
      // has no OP_RETURN support. We'd produce a tx the verifier rejects.
      console.error(
        "[pay-cli] warning: PIVX_SHIELD_FROM is set but the endpoint requires " +
          "scheme=pivx-transparent. Ignoring; paying from transparent UTXOs. " +
          "Shielded funds cannot pay a transparent x402 endpoint in one tx " +
          "(no OP_RETURN in Sapling sends). De-shield first, then pay.",
      );
    }
    txid = payTransparent(opts, requirement);
  } else if (requirement.scheme === "pivx-shield") {
    txid = payShielded(opts, requirement);
  } else {
    throw new Error(`unsupported scheme: ${requirement.scheme}`);
  }

  mineIfRegtest(opts, opts.mineBlocks);

  log(opts, `submitting proof to ${opts.url}`);
  const paid = await submitProofWithRetry(opts, opts.url, requirement, txid);
  log(opts, `response ${paid.status} ${paid.contentType} ${paid.body.length}B`);

  if (paid.status !== 200) {
    process.stderr.write(`payment rejected (${paid.status}): ${paid.body.toString("utf8")}\n`);
    process.exit(1);
  }

  if (opts.out) {
    writeFileSync(opts.out, paid.body);
    log(opts, `wrote ${opts.out}`);
  } else {
    process.stdout.write(paid.body);
  }
}

main().catch((err) => {
  console.error(`[pay-cli] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
