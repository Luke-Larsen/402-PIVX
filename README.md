# pivx402payment

**HTTP 402 Payment Required middleware for PIVX.**
Gate any Express route behind a real PIV payment — transparent or shielded —
in a few lines of code. Designed so humans, scripts, and AI agents all pay
the same way.

Live demo: **https://pivx402.computingcache.com/cat** (one SVG cat per 0.0001 PIV)

There are two roles you can play with this library. The README is split that
way; jump to whichever applies:

- **[A. I want to run a paywall](#a-run-a-paywall)** — gate one or more HTTP
  endpoints so visitors must pay PIVX to access them.
- **[B. I want to build a bot that pays paywalls](#b-build-a-bot-that-pays-paywalls)** —
  call somebody else's 402 endpoint programmatically, sign+broadcast the
  payment, retry with the proof.

Both roles share the same protocol envelope, error codes, and verification
rules. See the **[API reference](#api-reference)** and
**[Protocol cheat sheet](#protocol-cheat-sheet)** at the bottom when you need
the full surface, and **[Gotchas](#gotchas-we-actually-hit)** for the things
that bit us in production.

---

## Why HTTP 402?

`402 Payment Required` is the long-reserved HTTP status code for "this
resource costs money." x402 is the emerging convention for actually using
it. This package implements the x402 handshake on **PIVX**, with first-class
support for both:

- **`pivx-transparent`** — normal `D...` addresses; the nonce travels as an
  `OP_RETURN` output. Verifiable by any block explorer.
- **`pivx-shield`** — Sapling `ps1...` addresses; the nonce travels as the
  shielded **memo**. Amount, sender, recipient, and memo are all encrypted
  on-chain. Requires a `pivxd` node holding the receiver's viewing key.

The same middleware, the same client code, the same proof envelope — the
backend switches between transparent verification and shielded decryption
under the hood.

---

# A. Run a paywall

You want incoming requests to your API/endpoint to pay you PIVX before the
response is served.

## 1. Pick where you'll verify payments from

| Backend           | What it needs                                      | When to use                                                            |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `ExplorerBackend` | An HTTPS URL to a BlockBook-compatible PIVX explorer | Easiest. No node to maintain. Transparent-scheme only. Trusts the explorer. |
| `NodeRpcBackend`  | A locally-reachable `pivxd` JSON-RPC + creds       | Full control. Required for **shielded** payments. ~20 GB disk, real RAM. |

Public PIVX BlockBook explorers come and go — `blockbook.pivx.org`
disappeared on us in May 2026. **`https://explorer.duddino.com` is the
current default in this package.** If it ever goes down, you can point at
any other BlockBook-compatible PIVX mirror or run your own.

## 2. Install

```bash
npm install pivx402payment
```

Node ≥ 20. Works with Express 4. (Express 5 untested; should be a small fix
if it bites you.)

## 3. Wire it up

```ts
import express from "express";
import { pivx402, ExplorerBackend } from "pivx402payment";

const app = express();

app.get(
  "/api/paid-thing",
  pivx402({
    backend: new ExplorerBackend({ baseUrl: "https://explorer.duddino.com" }),
    network: "pivx-mainnet",
    minConfirmations: 1,
    price: {
      amount: "0.0001",            // decimal PIV
      payTo: "D...your address",   // mainnet PIVX address you control
      description: "what they're buying",
    },
  }),
  (req, res) => {
    // req.pivx402 contains { txid, nonce, amount, payTo, scheme, network }
    // — useful for receipts, audit logs, download tokens, abuse-rate-limiting.
    res.json({ ok: true, paidWith: req.pivx402!.txid });
  },
);

app.listen(4403);
```

That's the whole paywall. The first `GET /api/paid-thing` returns **`402
Payment Required`** with a machine-readable `X-Payment-Required` header.
The caller pays the quoted PIV to your address (embedding a server-issued
nonce as an `OP_RETURN`), then retries with `X-Payment: <proof>`. The
middleware verifies the on-chain transaction through your backend and runs
the handler.

## 4. Pick price + confirmations sensibly

```ts
// Static price for a single SKU:
price: { amount: "0.001", payTo: "...", description: "..." }

// Per-request price (sync or async):
price: async (req) => ({
  amount: await priceFor(req.params.sku),
  payTo: process.env.PIVX_PAY_TO!,
})
```

| `minConfirmations` | When to use                                                              |
| ------------------ | ------------------------------------------------------------------------ |
| `0`                | Cheap requests (<<$0.10 of PIV). Accepts mempool. Trades safety for UX.  |
| `1` (default)      | Sensible default. PIVX block time ≈ 1 min.                               |
| `6+`               | Larger amounts; you don't want a re-org to lose your money.              |

## 5. Replace `InMemoryNonceStore` in production

The default nonce store is in-memory. That means:
- Lost on restart (already-paid nonces become replayable).
- Doesn't work across multiple app instances.

Implement `NonceStore` against Redis or Postgres:

```ts
class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: Redis) {}
  async claim(nonce: string): Promise<boolean> {
    // SET NX guarantees a single winner per nonce.
    const r = await this.redis.set(`pivx402:nonce:${nonce}`, "1", "NX", "EX", 86400);
    return r === "OK";
  }
}

pivx402({ ..., nonceStore: new RedisNonceStore(myRedis) });
```

## 6. Deploy

A Dockerfile + `docker-compose.yml` are included for the cat-demo flavor.
Adapt for your own server:

```yaml
services:
  paywall:
    build: .
    restart: unless-stopped
    env_file: .env
    ports:
      - "127.0.0.1:4403:4403"   # apache/nginx reverse-proxies in front
```

A `.env.example` is included with the env vars demo/cat.ts reads.

---

# B. Build a bot that pays paywalls

You want to programmatically pay 402-gated endpoints — an AI agent,
scraper, batch process, anything.

## 1. Install

```bash
npm install pivx402payment
```

You also need **a way to broadcast PIVX transactions** — a wallet your bot
can drive. Options, easiest first:

| Signer                            | What you'll need                                       |
| --------------------------------- | ------------------------------------------------------ |
| **Local `pivxd` + JSON-RPC**      | The full PIVX daemon, ~20 GB disk, RPC creds. Most reliable. |
| **`pivx-cli` shell from your bot** | Just the binaries; convenient if you already run `pivxd` for other reasons. |
| **A custodial/hosted wallet API** | Whatever HTTPS API your wallet provider exposes.       |

The library doesn't care which — you give it a `payer` function whose only
job is "given this payment requirement, return a broadcast txid."

## 2. The 5-line version

```ts
import { payAndFetch, type Payer } from "pivx402payment";

const payer: Payer = async (req) => {
  // req.scheme, req.payTo, req.maxAmountRequired, req.nonce, req.network
  return await myWallet.sendWithOpReturn(req.payTo, req.maxAmountRequired, req.nonce);
};

const { response } = await payAndFetch("https://api.example.com/paid-thing", payer);
const data = await response.json();
```

`payAndFetch` does the dance:
1. GETs the URL.
2. If 200, returns immediately.
3. If 402, decodes `X-Payment-Required`, hands the requirement to your
   `payer`, retries with `X-Payment` set to the proof.
4. Anything else surfaces on `response` for you to handle.

## 3. A working `Payer` against a local `pivxd`

This is the recipe we use in `demo/pay-cli.ts` and in the live agent run
that paid https://pivx402.computingcache.com/cat:

```ts
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import type { Payer } from "pivx402payment";

const PIVX_CLI = "/path/to/pivx-cli";
const PIVX_TX  = "/path/to/pivx-tx";
const DATADIR  = "/path/to/.pivx";

const cli = (...args: string[]) =>
  execFileSync(PIVX_CLI, ["-datadir=" + DATADIR, ...args], { encoding: "utf8" }).trim();
const ptx = (...args: string[]) =>
  execFileSync(PIVX_TX, args, { encoding: "utf8" }).trim();

export const pivxdPayer: Payer = async (req) => {
  // 1. Build a tx that pays the requirement (no OP_RETURN yet).
  //    PIVX 5.x createrawtransaction does NOT accept the {"data":hex} shorthand,
  //    so we splice the OP_RETURN in afterward with pivx-tx.
  const raw = cli("createrawtransaction", "[]",
                  JSON.stringify({ [req.payTo]: Number(req.maxAmountRequired) }));

  // 2. Let the wallet add inputs + change. feeRate 0.0005 PIV/kB leaves headroom
  //    for the OP_RETURN we're about to splice in — fundrawtransaction can't see it yet.
  const funded = JSON.parse(cli("fundrawtransaction", raw,
                                JSON.stringify({ feeRate: 0.0005 }))).hex;

  // 3. Splice the nonce as an OP_RETURN output.
  const withOpReturn = ptx(funded, `outscript=0:OP_RETURN '${req.nonce}'`);

  // 4. Sign and broadcast.
  const signed = JSON.parse(cli("signrawtransaction", withOpReturn));
  if (!signed.complete) throw new Error("sign incomplete");
  return cli("sendrawtransaction", signed.hex);
};
```

That's the entire signer. The middleware on the other end reads the
`OP_RETURN`, matches it to its issued nonce, and serves the resource.

## 4. Failure modes and what your bot should do

When verification fails the server returns 402 again with an `error` field
on the envelope. Every reason is a stable string:

| `error`                       | Cause                                    | Bot's next action                                       |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `tx_not_found`                | Propagation delay; or wrong network      | Wait a few seconds, re-submit the same proof.            |
| `insufficient_confirmations`  | Broadcast but not yet deep enough        | Wait, re-submit. **Don't re-pay.**                       |
| `insufficient_amount`         | Paid less than `maxAmountRequired`       | Re-pay with at least the quoted amount on a new nonce.   |
| `wrong_recipient`             | Wrong `payTo`                            | Re-pay to the right address on a new nonce.              |
| `missing_nonce`               | Forgot the `OP_RETURN` / memo            | Re-pay including the nonce. Don't reuse the old txid.    |
| `nonce_replayed`              | This nonce was already spent             | Re-issue (`GET` again to get a fresh nonce), re-pay.     |
| `scheme_unsupported`          | Used wrong scheme                        | Switch scheme.                                           |
| `network_mismatch`            | Wrong network                            | Switch network on the wallet / endpoint.                 |
| `shielded_backend_unavailable`| Server misconfigured for shield          | Fall back to transparent if the server lists both.       |
| `malformed_payment_header`    | Bad base64 / JSON in `X-Payment`         | Fix your encoding.                                       |

`payAndFetch` itself just returns the `response`; the polling+retry logic
lives in your code. See `demo/pay-cli.ts` for a working retry loop that
handles propagation delay.

## 5. Spending guardrails for autonomous agents

Agents that spend real money should at least enforce:

```ts
import { payAndFetch, pivToSats, type Payer } from "pivx402payment";

const MAX_PER_CALL    = pivToSats("0.001");
const MAX_PER_SESSION = pivToSats("0.05");
const ALLOWED_HOSTS   = new Set(["pivx402.computingcache.com"]);
let spent = 0n;

const guardedPayer: Payer = async (req) => {
  const need = pivToSats(req.maxAmountRequired);
  if (need > MAX_PER_CALL)           throw new Error("over per-call cap");
  if (spent + need > MAX_PER_SESSION) throw new Error("over session cap");
  const txid = await rawPayer(req);
  spent += need;
  return txid;
};
```

See [AGENTS.md](./AGENTS.md) for more on the agent integration story
(consumer + builder paths, decision tree, prompt-friendly quick-reference card).

---

# API reference

### `pivx402(opts) → express.RequestHandler`

| Option              | Type                                                   | Required | Description                                                                                  |
| ------------------- | ------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------- |
| `backend`           | `PivxBackend`                                          | yes      | `NodeRpcBackend` or `ExplorerBackend` (or your own).                                         |
| `network`           | `"pivx-mainnet" \| "pivx-testnet" \| "pivx-regtest"`   | yes      | Network label echoed back to clients.                                                        |
| `scheme`            | `"pivx-transparent" \| "pivx-shield"`                  | no       | Default: `"pivx-transparent"`.                                                               |
| `minConfirmations`  | `number`                                               | no       | Default 1. `0` accepts mempool.                                                              |
| `maxTimeoutSeconds` | `number`                                               | no       | Default 600.                                                                                 |
| `price`             | `PriceConfig \| (req) => PriceConfig \| Promise<PriceConfig>` | yes | Static or per-request price.                                                                 |
| `nonceStore`        | `NonceStore`                                           | no       | Default `InMemoryNonceStore` (swap for Redis in production).                                 |

### Backends

```ts
import { NodeRpcBackend, ExplorerBackend } from "pivx402payment";

// pivxd JSON-RPC — required for shielded verification.
new NodeRpcBackend({ url: "http://127.0.0.1:51473", username: "u", password: "p" });

// BlockBook-compatible explorer — transparent only.
new ExplorerBackend({ baseUrl: "https://explorer.duddino.com" });
```

Implement your own by satisfying `PivxBackend`:

```ts
interface PivxBackend {
  getTransaction(txid: string): Promise<TxInfo | null>;
  viewShieldedTransaction?(txid: string): Promise<ShieldedTxInfo | null>;
}
```

### Client helper

```ts
import { payAndFetch, type Payer } from "pivx402payment";
const { response, requirement, txid } = await payAndFetch(url, payer);
```

### Headers

| Header                | Direction          | Carries                                              |
| --------------------- | ------------------ | ---------------------------------------------------- |
| `X-Payment-Required`  | server → client    | base64(`PaymentRequiredEnvelope`) on 402 responses   |
| `X-Payment`           | client → server    | base64(`PaymentProof`) on retries                    |

Both headers carry the same JSON in the response body as well.

---

# Protocol cheat sheet

```
GET /resource
  → 402 + X-Payment-Required: base64({ x402Version: 1, accepts: [requirement] })

requirement = {
  scheme: "pivx-transparent" | "pivx-shield",
  network: "pivx-mainnet" | "pivx-testnet" | "pivx-regtest",
  asset: "PIV",
  maxAmountRequired: "0.0001",    // decimal PIV string
  payTo: "D...",                   // ps1... for shielded
  nonce: "<32-hex-chars>",
  minConfirmations: number,
  maxTimeoutSeconds: number,
  resource: "/resource",
  description?: string,
}

Pay: send >= maxAmountRequired PIV to payTo,
     embed nonce in OP_RETURN (transparent) or memo (shielded).

GET /resource
  X-Payment: base64({
    x402Version: 1,
    scheme, network,
    payload: { txid, nonce }
  })
  → 200 + resource body
  → 402 + { error: <reason> } if verification failed
```

---

# Gotchas we actually hit

In rough order of "how long this cost us":

1. **`createrawtransaction` in PIVX 5.x does NOT accept the `{"data": hex}`
   shorthand for OP_RETURN.** Newer Bitcoin Core does; PIVX doesn't (yet).
   You must build the tx with only the recipient output, `fundrawtransaction`
   it, then splice the `OP_RETURN` in via `pivx-tx outscript=N:OP_RETURN '<nonce>'`,
   then sign. `demo/pay-cli.ts` shows the working pattern.

2. **`fundrawtransaction` doesn't know about the OP_RETURN you're about to
   splice.** It sizes the fee based on the tx *before* the OP_RETURN gets
   added, so the broadcast fails with `insufficient fee: X < Y`. Bump
   `feeRate` to ~`0.0005 PIV/kB` to leave headroom for the ~40-byte
   OP_RETURN; the absolute fee is still negligible.

3. **PIVX Core's debug-console UI strips double quotes from JSON args.**
   Pasting `createrawtransaction [] {"D...":0.0001,...}` returns
   `Error parsing JSON:{D...:0.0001,...}`. Workarounds, easiest first:
     - Run from a shell: `pivx-cli createrawtransaction "[]" '{"...":0.0001}'`
       (shell single-quotes preserve the inner doubles).
     - In the GUI, escape the inner quotes: `createrawtransaction []
       {\"D...\":0.0001}` — works in current PIVX Core builds.

4. **The "Latest" snapshot URL on `snapshot.rockdev.org` can rotate to a
   new file mid-download** — if you use `curl -C -` to resume, you'll get
   a Frankenstein file (bytes from snapshot A + B) and `gzip -t` fails
   with `invalid compressed data--format violated`. Always pass
   `--header "If-Range: <ETag>"` and prefer the `*Backup*.tgz` URL, which
   is stable.

5. **`checkblocks=0` in `pivx.conf` means "verify ALL blocks", not zero.**
   This wedges pivxd in startup for many hours after a snapshot install.
   Use `checkblocks=1` (or just leave the default 288) for a trusted snapshot.

6. **`pivxd` startup needs a generous `dbcache=` after a snapshot install.**
   The default ~300 MB causes a sea of random reads against the block index;
   `dbcache=4096` lets it fit in RAM and warm up in minutes instead of
   hours.

7. **PIVX's `getblockchaininfo` calls the IBD field
   `initial_block_downloading`** (snake_case + plural), not Bitcoin Core's
   `initialblockdownload`. Easy to miss when adapting Bitcoin-Core-flavored
   sync scripts.

8. **Public BlockBook mirrors are not durable.** `blockbook.pivx.org`
   disappeared on us mid-demo. Always have a fallback configured and
   make `PIVX_EXPLORER_URL` overridable at deploy time.

9. **`docker compose restart` does not re-read `.env`.** It just restarts
   the existing container with its existing env. To pick up new env vars
   you need `docker compose up -d` (which recreates the container).

---

# Production deployment

- **Use a real `pivxd`** if you can: explorer backends are a third-party
  trust assumption, and shielded verification *requires* viewing keys
  you'd never hand to a public explorer.
- **Replace `InMemoryNonceStore`.** Per-process, lost on restart. Use
  Redis/Postgres.
- **Lock down the RPC port.** `pivxd`'s JSON-RPC has no rate limiting;
  bind to localhost and front it with your app.
- **Mind dust limits.** PIVX rejects sends below ~0.0001 PIV in practice.
- **`MIN_CONFIRMATIONS` is a knob, not a default.** 0 for cheap calls, 6+
  for anything you'd be sad to lose to a re-org.

---

# Repo layout

```
src/
  index.ts          # public exports
  middleware.ts     # express middleware (pivx402)
  verifier.ts       # transparent + shielded verification
  backends/         # NodeRpcBackend, ExplorerBackend, PivxBackend interface
  headers.ts        # X-Payment / X-Payment-Required encoding
  client.ts         # payAndFetch helper for callers
  nonce-store.ts    # in-memory NonceStore (swap for Redis)
  amount.ts         # PIV ↔ satoshi conversion
  types.ts
demo/
  cat.ts            # the cat SaaS (/cat -> 402 -> SVG)
  server.ts         # weather demo
  client.ts         # interactive payer (pivx-cli command shown)
  pay-cli.ts        # one-shot payer that drives pivx-cli + pivx-tx
test/
  *.test.ts         # 20 tests: transparent + shield verification, client
install.sh          # downloads pivxd, runs regtest, starts the cat demo
Dockerfile          # production-style container for the cat demo
docker-compose.yml  # local + server-side compose
AGENTS.md           # AI-agent integration guide
```

---

# License

MIT — see [LICENSE](./LICENSE).
