#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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
  // shielded memo is hex-encoded; verifier UTF-8-decodes the bytes back to text.
  const memoHex = Buffer.from(req.nonce, "utf8").toString("hex");
  const out = [{ address: req.payTo, amount: Number(req.maxAmountRequired), memo: memoHex }];
  log(opts, `shieldsendmany from-any memo=${memoHex.slice(0, 16)}...`);
  // "from_any" lets the wallet pick any shielded source with funds.
  return cli(opts, "shieldsendmany", "from_any", JSON.stringify(out), "1");
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  log(opts, `GET ${opts.url}`);
  const { requirement } = await fetchRequirement(opts.url);
  log(opts, `requires ${requirement.maxAmountRequired} PIV ${requirement.scheme} -> ${requirement.payTo}`);
  log(opts, `nonce=${requirement.nonce}`);

  let txid: string;
  if (requirement.scheme === "pivx-transparent") txid = payTransparent(opts, requirement);
  else if (requirement.scheme === "pivx-shield") txid = payShielded(opts, requirement);
  else throw new Error(`unsupported scheme: ${requirement.scheme}`);

  mineIfRegtest(opts, opts.mineBlocks);

  log(opts, `submitting proof to ${opts.url}`);
  const paid = await submitProof(opts.url, requirement, txid);
  const body = Buffer.from(await paid.arrayBuffer());
  log(opts, `response ${paid.status} ${paid.headers.get("content-type")} ${body.length}B`);

  if (paid.status !== 200) {
    process.stderr.write(`payment rejected (${paid.status}): ${body.toString("utf8")}\n`);
    process.exit(1);
  }

  if (opts.out) {
    writeFileSync(opts.out, body);
    log(opts, `wrote ${opts.out}`);
  } else {
    process.stdout.write(body);
  }
}

main().catch((err) => {
  console.error(`[pay-cli] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
