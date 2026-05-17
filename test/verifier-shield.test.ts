import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PivxBackend } from "../src/backends";
import { InMemoryNonceStore } from "../src/nonce-store";
import { Verifier } from "../src/verifier";
import type {
  PaymentProof,
  PaymentRequirement,
  ShieldedTxInfo,
  TxInfo,
} from "../src/types";

const SHIELD_ADDR = "ps1examplexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const NONCE = "cafe000000000000000000000000beef";

function makeReq(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: "pivx-shield",
    network: "pivx-mainnet",
    asset: "PIV",
    maxAmountRequired: "0.00000001",
    payTo: SHIELD_ADDR,
    nonce: NONCE,
    minConfirmations: 1,
    maxTimeoutSeconds: 600,
    resource: "/cat",
    ...overrides,
  };
}

function makeProof(): PaymentProof {
  return {
    x402Version: 1,
    scheme: "pivx-shield",
    network: "pivx-mainnet",
    payload: { txid: "shieldtx", nonce: NONCE },
  };
}

function shieldedBackend(tx: ShieldedTxInfo | null): PivxBackend {
  return {
    async getTransaction(): Promise<TxInfo | null> {
      throw new Error("transparent getTransaction should not be called for shielded scheme");
    },
    async viewShieldedTransaction() {
      return tx;
    },
  };
}

const goodShieldTx: ShieldedTxInfo = {
  txid: "shieldtx",
  confirmations: 2,
  shieldedOutputs: [
    { address: SHIELD_ADDR, value: "0.00000001", memoText: NONCE, outgoing: false },
  ],
};

test("shield verifier: accepts a valid shielded payment", async () => {
  const v = new Verifier({
    backend: shieldedBackend(goodShieldTx),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.ok, true);
});

test("shield verifier: backend without viewShieldedTransaction is rejected", async () => {
  const transparentOnly: PivxBackend = {
    async getTransaction() {
      return null;
    },
  };
  const v = new Verifier({
    backend: transparentOnly,
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "shielded_backend_unavailable");
});

test("shield verifier: tx_not_found when node has no record", async () => {
  const v = new Verifier({
    backend: shieldedBackend(null),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "tx_not_found");
});

test("shield verifier: wrong_recipient when no incoming output to payTo", async () => {
  const wrongAddr: ShieldedTxInfo = {
    ...goodShieldTx,
    shieldedOutputs: [
      { address: "ps1somethingelse", value: "0.00000001", memoText: NONCE, outgoing: false },
    ],
  };
  const v = new Verifier({
    backend: shieldedBackend(wrongAddr),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "wrong_recipient");
});

test("shield verifier: ignores outgoing outputs to self", async () => {
  const outgoingOnly: ShieldedTxInfo = {
    ...goodShieldTx,
    shieldedOutputs: [
      { address: SHIELD_ADDR, value: "0.00000001", memoText: NONCE, outgoing: true },
    ],
  };
  const v = new Verifier({
    backend: shieldedBackend(outgoingOnly),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "wrong_recipient");
});

test("shield verifier: missing_nonce when memo doesn't carry the nonce", async () => {
  const noMemo: ShieldedTxInfo = {
    ...goodShieldTx,
    shieldedOutputs: [
      { address: SHIELD_ADDR, value: "0.00000001", memoText: "wrong", outgoing: false },
    ],
  };
  const v = new Verifier({
    backend: shieldedBackend(noMemo),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "missing_nonce");
});

test("shield verifier: insufficient_amount", async () => {
  const small: ShieldedTxInfo = {
    ...goodShieldTx,
    shieldedOutputs: [
      { address: SHIELD_ADDR, value: "0.00000001", memoText: NONCE, outgoing: false },
    ],
  };
  const v = new Verifier({
    backend: shieldedBackend(small),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq({ maxAmountRequired: "0.00010000" }), makeProof());
  assert.equal(result.reason, "insufficient_amount");
});
