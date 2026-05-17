import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  encodeRequirements,
  decodeProof,
  HEADER_PAYMENT,
  HEADER_PAYMENT_REQUIRED,
} from "../src/headers";
import { payAndFetch } from "../src/client";
import type { PaymentRequirement } from "../src/types";

const REQ: PaymentRequirement = {
  scheme: "pivx-transparent",
  network: "pivx-mainnet",
  asset: "PIV",
  maxAmountRequired: "0.01",
  payTo: "D7VFeM7zPVtjwoTW1cD5BdQ6ERSXNXtBYK",
  nonce: "deadbeefcafebabe0000000000000001",
  minConfirmations: 1,
  maxTimeoutSeconds: 600,
  resource: "/cat",
};

test("payAndFetch: returns 200 directly when no payment required", async () => {
  const fetchImpl = (async () =>
    new Response("ok", { status: 200 })) as unknown as typeof fetch;
  const result = await payAndFetch("http://x/y", async () => "ignored", { fetchImpl });
  assert.equal(result.response.status, 200);
  assert.equal(result.txid, "");
});

test("payAndFetch: does the 402 dance and attaches X-Payment on retry", async () => {
  let call = 0;
  let sentPayment = "";
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    call++;
    if (call === 1) {
      const headers = new Headers();
      headers.set(HEADER_PAYMENT_REQUIRED, encodeRequirements({ x402Version: 1, accepts: [REQ] }));
      return new Response("", { status: 402, headers });
    }
    sentPayment = ((init?.headers as Record<string, string>) ?? {})[HEADER_PAYMENT];
    return new Response("cat", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await payAndFetch("http://x/cat", async (req) => {
    assert.equal(req.nonce, REQ.nonce);
    return "tx-broadcast-id";
  }, { fetchImpl });

  assert.equal(result.response.status, 200);
  assert.equal(result.txid, "tx-broadcast-id");
  assert.ok(sentPayment, "X-Payment header should be set on retry");
  const proof = decodeProof(sentPayment);
  assert.equal(proof.payload.txid, "tx-broadcast-id");
  assert.equal(proof.payload.nonce, REQ.nonce);
});

test("payAndFetch: throws when payer returns empty txid", async () => {
  const fetchImpl = (async () => {
    const headers = new Headers();
    headers.set(HEADER_PAYMENT_REQUIRED, encodeRequirements({ x402Version: 1, accepts: [REQ] }));
    return new Response("", { status: 402, headers });
  }) as unknown as typeof fetch;
  await assert.rejects(payAndFetch("http://x/y", async () => "", { fetchImpl }), /empty txid/);
});
