import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NodeRpcBackend } from "../src/backends/node-rpc";

interface RpcCall {
  method: string;
  params: unknown[];
}

// Capture-and-respond fake JSON-RPC server. Returns the next queued response
// for each call (in order), and records the method+params for assertions.
function fakeRpc(responses: Array<Record<string, unknown>>): {
  fetchImpl: typeof fetch;
  calls: RpcCall[];
} {
  const calls: RpcCall[] = [];
  let idx = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string) as RpcCall;
    calls.push({ method: body.method, params: body.params });
    const result = responses[idx++] ?? null;
    return new Response(JSON.stringify({ result, error: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

test("node-rpc: viewShieldedTransaction calls the right RPC method (not the Zcash name)", async () => {
  // Regression: pivxd's RPC is `viewshieldtransaction`, not `viewshieldedtransaction`.
  const { fetchImpl, calls } = fakeRpc([
    { txid: "abc", outputs: [{ address: "ps1...", value: 0.0001, memoStr: "nonce", outgoing: false }] },
    { confirmations: 3 },
  ]);
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  await backend.viewShieldedTransaction("abc");
  assert.equal(calls[0].method, "viewshieldtransaction");
  assert.deepEqual(calls[0].params, ["abc"]);
});

test("node-rpc: viewShieldedTransaction reads `outputs` field (not `shielded_outputs`)", async () => {
  // Regression: pivxd returns `outputs`, not `shielded_outputs` (Zcash-style).
  const { fetchImpl } = fakeRpc([
    {
      txid: "abc",
      outputs: [
        { address: "ps1xyz", value: 0.5, memoStr: "deadbeef", outgoing: false },
      ],
    },
    { confirmations: 7 },
  ]);
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  const result = await backend.viewShieldedTransaction("abc");
  assert.ok(result);
  assert.equal(result.shieldedOutputs.length, 1);
  assert.equal(result.shieldedOutputs[0].address, "ps1xyz");
  assert.equal(result.shieldedOutputs[0].memoText, "deadbeef");
});

test("node-rpc: viewShieldedTransaction fetches confirmations via getrawtransaction", async () => {
  const { fetchImpl, calls } = fakeRpc([
    { txid: "abc", outputs: [] },
    { confirmations: 42 },
  ]);
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  const result = await backend.viewShieldedTransaction("abc");
  assert.ok(result);
  assert.equal(calls[1].method, "getrawtransaction");
  assert.deepEqual(calls[1].params, ["abc", true]);
  assert.equal(result.confirmations, 42);
});

test("node-rpc: viewShieldedTransaction returns 0 confirmations when tx is in mempool only", async () => {
  const calls: RpcCall[] = [];
  let idx = 0;
  const responses = [
    { result: { txid: "abc", outputs: [] }, error: null },
    // mempool tx: getrawtransaction returns an error like "-5 No such mempool..."
    { result: null, error: { code: -5, message: "No such mempool or blockchain transaction" } },
  ];
  const fetchImpl: typeof fetch = async (_u, init) => {
    const body = JSON.parse(init!.body as string) as RpcCall;
    calls.push({ method: body.method, params: body.params });
    return new Response(JSON.stringify(responses[idx++]), { status: 200 });
  };
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  const result = await backend.viewShieldedTransaction("abc");
  assert.ok(result);
  assert.equal(result.confirmations, 0);
});

test("node-rpc: viewShieldedTransaction decodes hex memo when memoStr absent", async () => {
  const { fetchImpl } = fakeRpc([
    {
      txid: "abc",
      // No memoStr — memo bytes are hex. "cafebeef" + padding nulls.
      outputs: [
        { address: "ps1xyz", valueSat: 12345, memo: "636166656265656600000000", outgoing: false },
      ],
    },
    { confirmations: 1 },
  ]);
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  const result = await backend.viewShieldedTransaction("abc");
  assert.ok(result);
  // 0x63 0x61 0x66 0x65 0x62 0x65 0x65 0x66 -> "cafebeef", trailing nulls stripped.
  assert.equal(result.shieldedOutputs[0].memoText, "cafebeef");
  assert.equal(result.shieldedOutputs[0].value, "0.00012345");
});

test("node-rpc: viewShieldedTransaction returns null when tx not in wallet (-5)", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({ result: null, error: { code: -5, message: "No information available about transaction" } }),
      { status: 200 },
    );
  const backend = new NodeRpcBackend({ url: "http://localhost", fetchImpl });
  const result = await backend.viewShieldedTransaction("abc");
  assert.equal(result, null);
});
