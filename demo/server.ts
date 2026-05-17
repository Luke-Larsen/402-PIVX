import express from "express";
import {
  ExplorerBackend,
  NodeRpcBackend,
  pivx402,
  type Network,
  type PivxBackend,
} from "../src";

const PORT = Number(process.env.PORT ?? 4402);
const PAY_TO = process.env.PIVX_PAY_TO ?? "D7VFeM7zPVtjwoTW1cD5BdQ6ERSXNXtBYK";
const PRICE = process.env.PRICE_PIV ?? "0.01";
const NETWORK: Network = networkFromEnv(process.env.PIVX_NETWORK);

function networkFromEnv(v: string | undefined): Network {
  switch (v) {
    case "mainnet": case undefined: case "": return "pivx-mainnet";
    case "testnet": return "pivx-testnet";
    case "regtest": return "pivx-regtest";
    default: return v as Network;
  }
}

function makeBackend(): PivxBackend {
  if (process.env.PIVX_RPC_URL) {
    return new NodeRpcBackend({
      url: process.env.PIVX_RPC_URL,
      username: process.env.PIVX_RPC_USER,
      password: process.env.PIVX_RPC_PASSWORD,
    });
  }
  const explorer = process.env.PIVX_EXPLORER_URL ?? "https://blockbook.pivx.org";
  return new ExplorerBackend({ baseUrl: explorer });
}

const app = express();

app.get(
  "/weather",
  pivx402({
    backend: makeBackend(),
    network: NETWORK,
    minConfirmations: Number(process.env.MIN_CONFIRMATIONS ?? 1),
    price: { amount: PRICE, payTo: PAY_TO, description: "current weather (paid)" },
  }),
  (_req, res) => {
    res.json({ city: "Zurich", tempC: 18, conditions: "partly cloudy" });
  },
);

app.get("/", (_req, res) => {
  res.json({ try: "GET /weather", priceInPiv: PRICE, payTo: PAY_TO });
});

app.listen(PORT, () => {
  console.log(`pivx402 demo listening on http://127.0.0.1:${PORT}`);
  console.log(`  GET /weather  -> ${PRICE} PIV to ${PAY_TO}`);
});
