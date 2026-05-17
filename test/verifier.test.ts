import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PivxBackend } from "../src/backends";
import { InMemoryNonceStore } from "../src/nonce-store";
import { Verifier } from "../src/verifier";
import type { PaymentProof, PaymentRequirement, TxInfo } from "../src/types";

const PAY_TO = "D7VFeM7zPVtjwoTW1cD5BdQ6ERSXNXtBYK";
const NONCE = "deadbeefcafebabe0000000000000001";

function makeReq(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: "pivx-transparent",
    network: "pivx-mainnet",
    asset: "PIV",
    maxAmountRequired: "0.01",
    payTo: PAY_TO,
    nonce: NONCE,
    minConfirmations: 1,
    maxTimeoutSeconds: 600,
    resource: "/api/weather",
    ...overrides,
  };
}

function makeProof(overrides: Partial<PaymentProof["payload"]> = {}): PaymentProof {
  return {
    x402Version: 1,
    scheme: "pivx-transparent",
    network: "pivx-mainnet",
    payload: { txid: "abc", nonce: NONCE, ...overrides },
  };
}

function backendReturning(tx: TxInfo | null): PivxBackend {
  return {
    async getTransaction() {
      return tx;
    },
  };
}

const goodTx: TxInfo = {
  txid: "abc",
  confirmations: 3,
  outputs: [
    { value: "0.01000000", address: PAY_TO, opReturnText: null },
    { value: null, address: null, opReturnText: NONCE },
  ],
};

test("verifier: accepts a valid payment", async () => {
  const v = new Verifier({ backend: backendReturning(goodTx), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.ok, true);
});

test("verifier: rejects tx_not_found", async () => {
  const v = new Verifier({ backend: backendReturning(null), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.ok, false);
  assert.equal(result.reason, "tx_not_found");
});

test("verifier: rejects insufficient_confirmations", async () => {
  const v = new Verifier({
    backend: backendReturning({ ...goodTx, confirmations: 0 }),
    nonceStore: new InMemoryNonceStore(),
  });
  const result = await v.verify(makeReq({ minConfirmations: 1 }), makeProof());
  assert.equal(result.reason, "insufficient_confirmations");
});

test("verifier: rejects wrong_recipient", async () => {
  const wrong: TxInfo = {
    ...goodTx,
    outputs: [
      { value: "0.01000000", address: "D9999999999999999999999999999999999", opReturnText: null },
      { value: null, address: null, opReturnText: NONCE },
    ],
  };
  const v = new Verifier({ backend: backendReturning(wrong), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "wrong_recipient");
});

test("verifier: rejects insufficient_amount", async () => {
  const small: TxInfo = {
    ...goodTx,
    outputs: [
      { value: "0.00500000", address: PAY_TO, opReturnText: null },
      { value: null, address: null, opReturnText: NONCE },
    ],
  };
  const v = new Verifier({ backend: backendReturning(small), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "insufficient_amount");
});

test("verifier: rejects missing OP_RETURN nonce", async () => {
  const noNonce: TxInfo = {
    ...goodTx,
    outputs: [{ value: "0.01000000", address: PAY_TO, opReturnText: null }],
  };
  const v = new Verifier({ backend: backendReturning(noNonce), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.reason, "missing_nonce");
});

test("verifier: rejects nonce_replayed on second use", async () => {
  const store = new InMemoryNonceStore();
  const v = new Verifier({ backend: backendReturning(goodTx), nonceStore: store });
  const first = await v.verify(makeReq(), makeProof());
  assert.equal(first.ok, true);
  const second = await v.verify(makeReq(), makeProof());
  assert.equal(second.reason, "nonce_replayed");
});

test("verifier: rejects proof/requirement nonce mismatch", async () => {
  const v = new Verifier({ backend: backendReturning(goodTx), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof({ nonce: "different" }));
  assert.equal(result.reason, "missing_nonce");
});

test("verifier: rejects scheme mismatch", async () => {
  const v = new Verifier({ backend: backendReturning(goodTx), nonceStore: new InMemoryNonceStore() });
  const proof: PaymentProof = { ...makeProof(), scheme: "pivx-shield" };
  const result = await v.verify(makeReq(), proof);
  assert.equal(result.reason, "scheme_unsupported");
});

test("verifier: aggregates multiple outputs to payTo", async () => {
  const split: TxInfo = {
    ...goodTx,
    outputs: [
      { value: "0.00600000", address: PAY_TO, opReturnText: null },
      { value: "0.00400000", address: PAY_TO, opReturnText: null },
      { value: null, address: null, opReturnText: NONCE },
    ],
  };
  const v = new Verifier({ backend: backendReturning(split), nonceStore: new InMemoryNonceStore() });
  const result = await v.verify(makeReq(), makeProof());
  assert.equal(result.ok, true);
});
