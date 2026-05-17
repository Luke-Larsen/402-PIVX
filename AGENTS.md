# AGENTS.md — pivx402payment for AI agents

This file is for **AI agents** (Claude, GPT-class models, autonomous task
runners, tool-using LLM apps) and the engineers who build with them.

There are two roles to consider:

1. **Consumer**: an agent that *pays* a 402-gated PIVX endpoint to use it.
2. **Builder**: an agent (or a human + agent) that *builds* such an endpoint
   using this library.

The library is designed so both paths are short, predictable, and
deterministic — no UI, no out-of-band auth, no per-customer accounts. The
protocol is the account.

---

## Why this works well for agents

- **No accounts.** No signup form to fill out, no API key to leak in logs.
  The only credential is funds the agent already controls.
- **Machine-readable price.** The 402 response is a versioned JSON envelope.
  Agents don't have to scrape a pricing page.
- **Stable error codes.** Every verification failure returns a known
  `reason` string (see README), so an agent can react programmatically:
  "wait for confirmations", "top up wallet", "retry with bigger amount".
- **One handshake.** No webhooks, no callbacks, no polling — request, pay,
  retry, done.
- **Shielded by default available.** For agents that need to spend without
  revealing amounts on-chain (price-discovery probes, competitive ops),
  switch the scheme to `pivx-shield` — same envelope, same proof shape.

---

## Role 1: An agent that pays an endpoint

### Minimal recipe

```ts
import { payAndFetch, type Payer } from "pivx402payment";

const payer: Payer = async (req) => {
  // req.scheme:   "pivx-transparent" | "pivx-shield"
  // req.payTo:    PIVX address
  // req.maxAmountRequired: decimal PIV (string), e.g. "0.0001"
  // req.nonce:    server-issued; MUST appear in OP_RETURN or shielded memo
  // req.network:  "pivx-mainnet" | "pivx-testnet" | "pivx-regtest"
  //
  // Build, sign, broadcast. Return the broadcast txid.
  return await myWallet.sendWithOpReturn(req.payTo, req.maxAmountRequired, req.nonce);
};

const { response } = await payAndFetch("https://api.example.com/paid-thing", payer);
const data = await response.json();
```

That's the whole loop. `payAndFetch`:

1. GETs the URL.
2. If it's 200, returns immediately.
3. If it's 402, decodes `X-Payment-Required`, calls your `payer`, retries
   with `X-Payment` set to the proof.
4. Anything else surfaces on `response` for you to handle.

### Wallets / signing options

Agents typically reach the chain through one of:

- A **local `pivxd`** the agent operator controls. Most production-quality
  option; use the JSON-RPC `sendmany` / `shieldsendmany` to embed the nonce.
  `demo/pay-cli.ts` is a working reference.
- A **custodial signing service** (your wallet provider's HTTP API).
- A **hosted PIVX node** accessed over HTTPS.

The library doesn't care which — `Payer` is intentionally a single async
function: "given this requirement, return a broadcast txid."

### Failure modes and what an agent should do

| `error` reason                | Cause                                    | What the agent should do                                |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `tx_not_found`                | Propagation delay, or wrong network      | Wait a few seconds and re-submit the same proof.         |
| `insufficient_confirmations`  | Tx broadcast but not yet deep enough     | Wait, then re-submit. Don't re-pay.                      |
| `insufficient_amount`         | You paid less than `maxAmountRequired`   | Re-pay with at least the quoted amount on a new nonce.   |
| `wrong_recipient`             | Wrong `payTo`                            | Re-pay to the correct address on a new nonce.            |
| `missing_nonce`               | Forgot the `OP_RETURN` / memo            | Re-pay including the nonce. Don't reuse old txid.        |
| `nonce_replayed`              | This nonce was already spent             | Re-issue (`GET` again to get a fresh nonce), re-pay.     |
| `scheme_unsupported`          | Used wrong scheme                        | Re-pay with the scheme the server advertises.            |
| `network_mismatch`            | Wrong network                            | Switch the network on the wallet / endpoint.             |
| `shielded_backend_unavailable`| Server misconfigured for shield          | Fall back to transparent if the server lists both.       |

The error JSON is small enough to feed back into the model. A good agent
prompt: *"If the response contains `error: nonce_replayed`, re-issue the
request to obtain a new nonce; do not re-broadcast the old tx."*

### Budgets and guardrails

Agents that pay real money should have:

- **A per-call price ceiling.** Inspect `requirement.maxAmountRequired` before
  calling the `payer`. Refuse anything over your budget.
- **A per-session spending cap.** Track total paid; halt above a threshold.
- **A whitelist of `payTo` addresses or domains.** Don't pay an arbitrary
  address an attacker injected into a 402.
- **Idempotency tracking.** Store `txid` against the original request so a
  retry doesn't pay twice.

A simple wrapper:

```ts
const MAX_PIV_PER_CALL = "0.001";
const MAX_PIV_PER_SESSION = "0.05";
let spent = 0n;

const guardedPayer: Payer = async (req) => {
  const need = pivToSats(req.maxAmountRequired);
  if (need > pivToSats(MAX_PIV_PER_CALL)) throw new Error("over per-call cap");
  if (spent + need > pivToSats(MAX_PIV_PER_SESSION)) throw new Error("session cap");
  const txid = await payer(req);
  spent += need;
  return txid;
};
```

`pivToSats` is exported from this package.

---

## Role 2: An agent (or LLM-assisted dev) building a 402-gated endpoint

This is the workflow the model should follow when a user asks for a
"pay-per-request endpoint with PIVX" or "x402 endpoint for my API".

### Decision tree

1. **Does the resource have to be private on-chain?**
   - If **no** (typical case): `scheme: "pivx-transparent"`. Cheapest, works
     with any backend including explorers.
   - If **yes** (amount/sender must be hidden): `scheme: "pivx-shield"`. The
     server must run `pivxd` with the viewing key for the receiving shielded
     address.
2. **Where does on-chain data come from?**
   - Local `pivxd` → `NodeRpcBackend` (required for shield).
   - Public explorer → `ExplorerBackend` (transparent only; trust the explorer).
3. **What confirmations?**
   - `minConfirmations: 0` for tiny prices (<<$0.10 worth of PIV).
   - `minConfirmations: 1` for default.
   - `minConfirmations: 6` for anything you'd be sad to lose to a re-org.
4. **What price?**
   - Static for a single SKU: `price: { amount: "0.001", payTo: "...", description: "..." }`.
   - Per-request (dynamic): pass a function. Async is fine — useful when the
     price depends on a database row, the request body, or a real-time rate.
5. **What nonce store?**
   - Single-process / dev: omit, defaults to in-memory.
   - Production: implement `NonceStore` against Redis/Postgres. Just two
     async methods. Don't skip this — replay protection lives here.

### Template the agent should generate

```ts
import express from "express";
import { pivx402, NodeRpcBackend } from "pivx402payment";

const app = express();

app.get(
  "/path/to/resource",
  pivx402({
    backend: new NodeRpcBackend({
      url: process.env.PIVX_RPC_URL!,
      username: process.env.PIVX_RPC_USER,
      password: process.env.PIVX_RPC_PASSWORD,
    }),
    network: "pivx-mainnet",   // or pivx-testnet / pivx-regtest
    scheme: "pivx-transparent", // or pivx-shield
    minConfirmations: 1,
    price: {
      amount: "0.0001",
      payTo: process.env.PIVX_PAY_TO!,
      description: "what they're buying",
    },
  }),
  (req, res) => {
    // req.pivx402.txid is the on-chain proof of payment for this request.
    // Use it for receipts, audit logs, or download tokens.
    res.send(theThing);
  },
);

app.listen(Number(process.env.PORT ?? 4403));
```

### Things the agent should NOT do

- **Do not roll your own verification.** Use `pivx402(...)`. The verification
  logic (output aggregation, OP_RETURN parsing, memo decryption, nonce
  claiming) has subtle edge cases that are already tested in
  `test/verifier*.test.ts`.
- **Do not weaken the nonce check.** The OP_RETURN / memo nonce is what
  binds a public payment to a *specific server-issued challenge*. Without it
  any payment to `payTo` would unlock the resource for everyone.
- **Do not reuse a single `NonceStore` instance across unrelated routes
  without thinking about it.** Different routes can share one, but each
  successful payment burns its nonce — that's the whole point. The same
  txid + nonce cannot satisfy two routes.
- **Do not commit RPC credentials or `payTo` private keys.** `payTo` is a
  public address — that's fine in code or config. The private key for it
  belongs in the `pivxd` wallet only.
- **Do not catch and silently 200 on verification failures.** The middleware
  intentionally re-issues a fresh nonce on every failure; trust it.

### Verifying your build

1. Run `npm test` — covers all 9 verification reasons + the client helper.
2. Run `./install.sh` and pay the cat demo end-to-end:
   ```bash
   set -a; source .env.local; set +a
   npx tsx demo/pay-cli.ts -v --out /tmp/cat.svg http://127.0.0.1:4403/cat
   ```
   This proves the full loop works on regtest.
3. Hit your endpoint without payment — confirm 402 with a valid
   `X-Payment-Required` header.
4. Hit it twice with the same proof — second call must return 402 with
   `error: nonce_replayed`.

---

## Quick reference card

```
GET /resource
  → 402 + X-Payment-Required: base64({ x402Version: 1, accepts: [requirement] })

requirement = {
  scheme: "pivx-transparent" | "pivx-shield",
  network: "pivx-mainnet" | "pivx-testnet" | "pivx-regtest",
  asset: "PIV",
  maxAmountRequired: "0.0001",   // decimal PIV string
  payTo: "D...",                  // ps1... for shielded
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

If your agent stays inside this card, it can talk to any `pivx402payment`
endpoint without further help.
