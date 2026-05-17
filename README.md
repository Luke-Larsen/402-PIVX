# pivx402payment

**HTTP 402 Payment Required middleware for PIVX.**
Gate any Express route behind a real PIV payment — transparent or shielded —
in a few lines of code. Designed so humans, scripts, and AI agents all pay the
same way.

```ts
import express from "express";
import { pivx402, NodeRpcBackend } from "pivx402payment";

const app = express();

app.get(
  "/cat",
  pivx402({
    backend: new NodeRpcBackend({ url: "http://127.0.0.1:51473", username: "u", password: "p" }),
    network: "pivx-mainnet",
    price: { amount: "0.0001", payTo: "D7VFeM7zPVtjwoTW1cD5BdQ6ERSXNXtBYK", description: "one cat picture" },
  }),
  (_req, res) => res.sendFile("/srv/cats/tabby.svg"),
);

app.listen(4403);
```

That's the whole SaaS. The first `GET /cat` returns **`402 Payment Required`**
with a machine-readable `X-Payment-Required` header. The caller pays the
quoted PIV to the quoted address (embedding a server-issued nonce in the
transaction), then retries with `X-Payment: <proof>`. The middleware verifies
the on-chain transaction and serves the cat.

---

## Why HTTP 402?

`402 Payment Required` is the long-reserved HTTP status code for "this
resource costs money." x402 is the emerging convention for actually using it.
This package implements the x402 handshake on **PIVX**, with first-class
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

## Install

```bash
npm install pivx402payment
```

You also need a PIVX data source — either a local `pivxd` (recommended) or a
BlockBook-compatible explorer. The bundled `install.sh` will download `pivxd`,
spin up regtest, and start a working demo in one shot:

```bash
./install.sh                    # regtest + cat demo on :4403
./install.sh --mode testnet     # testnet node
./install.sh --mode mainnet     # mainnet node
```

---

## The cat SaaS, end-to-end

This is what's actually running in `demo/cat.ts`. It's the smallest possible
real-money web service: send 0.0001 PIV, get one PNG (well — SVG) of a cat.

### 1. The server

```ts
// demo/cat.ts (simplified)
import express from "express";
import { pivx402, NodeRpcBackend } from "pivx402payment";

const app = express();

app.get(
  "/cat",
  pivx402({
    backend: new NodeRpcBackend({
      url: process.env.PIVX_RPC_URL!,
      username: process.env.PIVX_RPC_USER,
      password: process.env.PIVX_RPC_PASSWORD,
    }),
    network: "pivx-mainnet",
    minConfirmations: 1,
    price: {
      amount: "0.0001",
      payTo: process.env.PIVX_PAY_TO!,
      description: "one (1) cat picture",
    },
  }),
  (req, res) => {
    // req.pivx402.txid is the broadcast tx that paid for this request.
    res.setHeader("Content-Type", "image/svg+xml").send(CAT_SVG);
  },
);

app.listen(4403);
```

That's it. Every request to `/cat` is gated. No accounts, no API keys, no
Stripe. Anyone with PIV can call it; nobody else can.

### 2. The handshake the server speaks

**First request (no payment):**

```
HTTP/1.1 402 Payment Required
X-Payment-Required: <base64 of envelope below>

{
  "x402Version": 1,
  "accepts": [{
    "scheme": "pivx-transparent",
    "network": "pivx-mainnet",
    "asset": "PIV",
    "maxAmountRequired": "0.0001",
    "payTo": "D7VFeM7z...",
    "nonce": "522283f862e4e5989b7617cb049fb49c",
    "minConfirmations": 1,
    "maxTimeoutSeconds": 600,
    "resource": "/cat",
    "description": "one (1) cat picture"
  }]
}
```

**The caller pays:** broadcast a PIVX tx that sends ≥ `maxAmountRequired` PIV
to `payTo`, with `OP_RETURN <nonce>` (transparent) or a memo containing the
nonce (shielded).

**Retry with proof:**

```
GET /cat
X-Payment: <base64 of {x402Version, scheme, network, payload:{txid, nonce}}>
```

The middleware:

1. Looks up the txid through the configured backend.
2. Confirms it pays ≥ the required amount to `payTo`, with `minConfirmations`.
3. Confirms the nonce appears in an `OP_RETURN` (or in the shielded memo).
4. Claims the nonce in the `NonceStore` so it can't be replayed.
5. Calls your handler, with `req.pivx402` set to `{ txid, nonce, amount, payTo, ... }`.

### 3. Three ways to pay it

#### Human, with `pivx-cli`:

```bash
# Build, sign, broadcast a tx with the nonce as OP_RETURN.
# Then submit txid as the X-Payment proof.
npx tsx demo/client.ts http://127.0.0.1:4403/cat
```

#### Anything with a local pivxd, in one shot:

```bash
set -a; source .env.local; set +a
npx tsx demo/pay-cli.ts -v --out /tmp/cat.svg http://127.0.0.1:4403/cat
```

`pay-cli` shells out to `pivx-cli` / `pivx-tx` for you, mines a block on
regtest, and writes the response body to disk.

#### An AI agent or any program:

```ts
import { payAndFetch } from "pivx402payment";

const { response } = await payAndFetch("http://127.0.0.1:4403/cat", async (req) => {
  // Build, sign, and broadcast a tx that pays req.maxAmountRequired PIV
  // to req.payTo with req.nonce in OP_RETURN. Return the broadcast txid.
  return await myWallet.sendWithOpReturn(req.payTo, req.maxAmountRequired, req.nonce);
});
const cat = await response.text();
```

`payAndFetch` does the 402 dance automatically; the only thing you provide is
a `payer` function that knows how to sign and broadcast on your wallet of
choice. See [AGENTS.md](./AGENTS.md) for full agent-integration recipes.

---

## API

### `pivx402(opts) → express.RequestHandler`

| Option              | Type                              | Required | Description                                                                                  |
| ------------------- | --------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `backend`           | `PivxBackend`                     | yes      | `NodeRpcBackend` or `ExplorerBackend` (or your own).                                         |
| `network`           | `"pivx-mainnet" \| "pivx-testnet" \| "pivx-regtest"` | yes | Network label echoed back to clients.                                                        |
| `scheme`            | `"pivx-transparent" \| "pivx-shield"` | no   | Default: `"pivx-transparent"`.                                                               |
| `minConfirmations`  | `number`                          | no       | Default 1. `0` accepts mempool.                                                              |
| `maxTimeoutSeconds` | `number`                          | no       | Default 600.                                                                                 |
| `price`             | `PriceConfig \| (req) => PriceConfig \| Promise<PriceConfig>` | yes | Static or per-request price.                                          |
| `nonceStore`        | `NonceStore`                      | no       | Default `InMemoryNonceStore` (swap for Redis in production).                                 |

### Backends

```ts
import { NodeRpcBackend, ExplorerBackend } from "pivx402payment";

// pivxd JSON-RPC — required for shielded verification.
new NodeRpcBackend({ url: "http://127.0.0.1:51473", username: "u", password: "p" });

// BlockBook-compatible explorer — transparent only.
new ExplorerBackend({ baseUrl: "https://blockbook.pivx.org" });
```

Write your own by implementing `PivxBackend`:

```ts
interface PivxBackend {
  getTransaction(txid: string): Promise<TxInfo | null>;
  viewShieldedTransaction?(txid: string): Promise<ShieldedTxInfo | null>;
}
```

### Verification result reasons

When verification fails the middleware returns 402 again with an `error` field
on the envelope. The reason is a stable string clients can match on:

| reason                          | meaning                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `tx_not_found`                  | Backend doesn't know that txid (yet).                                  |
| `insufficient_confirmations`    | Tx exists but hasn't accumulated enough blocks.                        |
| `wrong_recipient`               | Tx exists but no output goes to `payTo`.                               |
| `insufficient_amount`           | Output(s) to `payTo` sum to less than `maxAmountRequired`.             |
| `missing_nonce`                 | No `OP_RETURN` (or shielded memo) carries the issued nonce.            |
| `nonce_replayed`                | This nonce has already been spent against a previous request.          |
| `scheme_unsupported`            | Proof scheme doesn't match what the route accepts.                     |
| `network_mismatch`              | Proof network doesn't match what the route accepts.                    |
| `shielded_backend_unavailable`  | Route accepts `pivx-shield` but the configured backend can't decrypt.  |

### Client helper

```ts
import { payAndFetch, type Payer } from "pivx402payment";

const payer: Payer = async (req) => {
  // returns broadcast txid
};

const { response, requirement, txid } = await payAndFetch(url, payer);
```

---

## Headers

| Header                | Direction          | Carries                                              |
| --------------------- | ------------------ | ---------------------------------------------------- |
| `X-Payment-Required`  | server → client    | base64(`PaymentRequiredEnvelope`) on 402 responses   |
| `X-Payment`           | client → server    | base64(`PaymentProof`) on retries                    |

Both headers carry the same JSON in the response body as well, so naïve
clients that ignore headers can still parse the 402.

---

## Production deployment

- **Use a real `pivxd`.** Explorer backends work for transparent payments but
  are a third-party trust assumption — and shielded verification requires
  viewing keys you don't hand to anyone.
- **Pick a `minConfirmations` you can live with.** 0 means "accept mempool",
  which is fine for cheap requests where double-spend risk is bounded by the
  price. For larger amounts, raise it.
- **Replace `InMemoryNonceStore`.** Implement `NonceStore` against Redis,
  Postgres, or whatever you already run. The in-memory default is per-process
  and lost on restart.
- **Lock down the RPC port.** `pivxd`'s JSON-RPC has no rate limiting; bind it
  to localhost and front it with your app.
- **Mind dust limits.** PIVX rejects sends below ~0.0001 PIV in practice.

---

## Layout

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
  cat.ts            # the cat SaaS
  server.ts         # weather demo
  client.ts         # interactive payer (pivx-cli command shown)
  pay-cli.ts        # one-shot payer that drives pivx-cli + pivx-tx
test/
  *.test.ts
install.sh          # downloads pivxd, runs regtest, starts the cat demo
```

---

## License

MIT — see [LICENSE](./LICENSE).
