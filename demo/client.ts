import { createInterface } from "node:readline/promises";
import { decodeRequirements, encodeProof, HEADER_PAYMENT, HEADER_PAYMENT_REQUIRED } from "../src/headers";
import type { PaymentProof } from "../src/types";

async function main() {
  const url = process.argv[2] ?? "http://127.0.0.1:4402/weather";

  const first = await fetch(url);
  if (first.status !== 402) {
    console.log(`unexpected status ${first.status}`);
    console.log(await first.text());
    return;
  }

  const headerVal = first.headers.get(HEADER_PAYMENT_REQUIRED.toLowerCase());
  if (!headerVal) {
    console.error(`server returned 402 but no ${HEADER_PAYMENT_REQUIRED} header`);
    process.exit(1);
  }
  const env = decodeRequirements(headerVal);
  const req = env.accepts[0];

  console.log("Server requires payment:");
  console.log(`  send ${req.maxAmountRequired} ${req.asset} to ${req.payTo}`);
  console.log(`  include OP_RETURN with payload: ${req.nonce}`);
  console.log(`  on ${req.network}, minConf=${req.minConfirmations}`);
  console.log("");
  console.log("Example pivx-cli command (replace UTXO selection):");
  console.log(`  pivx-cli sendmany "" '{"${req.payTo}":${req.maxAmountRequired}}' ${req.minConfirmations} "" '[]' false "" "${req.nonce}"`);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const txid = (await rl.question("Paste the broadcast txid: ")).trim();
  rl.close();

  const proof: PaymentProof = {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    payload: { txid, nonce: req.nonce },
  };

  const paid = await fetch(url, { headers: { [HEADER_PAYMENT]: encodeProof(proof) } });
  console.log(`status: ${paid.status}`);
  console.log(await paid.text());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
