import express from "express";
import {
  ExplorerBackend,
  NodeRpcBackend,
  pivx402,
  type Network,
  type PivxBackend,
  type Scheme,
} from "../src";

// 0.0001 PIV (10,000 sats). PIVX's network dust limit is ~546 sats, but the
// wallet refuses sends below ~minRelayTxFee, which is higher; 0.0001 clears
// both with margin and is still a trivial test amount.
const PRICE = process.env.PRICE_PIV ?? "0.0001";
const SCHEME: Scheme = (process.env.SCHEME as Scheme) ?? "pivx-transparent";
const PORT = Number(process.env.PORT ?? 4403);
const NETWORK: Network = networkFromEnv(process.env.PIVX_NETWORK);

function networkFromEnv(v: string | undefined): Network {
  switch (v) {
    case "mainnet": case undefined: case "": return "pivx-mainnet";
    case "testnet": return "pivx-testnet";
    case "regtest": return "pivx-regtest";
    default: return v as Network;
  }
}

// For transparent: a normal D... address. For shield: a ps1... address.
const PAY_TO =
  process.env.PIVX_PAY_TO ??
  (SCHEME === "pivx-shield"
    ? "ps1examplexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
    : "D7VFeM7zPVtjwoTW1cD5BdQ6ERSXNXtBYK");

function makeBackend(): PivxBackend {
  if (process.env.PIVX_RPC_URL) {
    return new NodeRpcBackend({
      url: process.env.PIVX_RPC_URL,
      username: process.env.PIVX_RPC_USER,
      password: process.env.PIVX_RPC_PASSWORD,
    });
  }
  if (SCHEME === "pivx-shield") {
    throw new Error(
      "pivx-shield requires PIVX_RPC_URL (an explorer cannot decrypt shielded outputs)",
    );
  }
  const explorer = process.env.PIVX_EXPLORER_URL ?? "https://explorer.duddino.com";
  return new ExplorerBackend({ baseUrl: explorer });
}

const CAT_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240">
  <rect width="240" height="240" fill="#fff4e6"/>
  <ellipse cx="120" cy="170" rx="70" ry="55" fill="#a67242"/>
  <circle cx="120" cy="105" r="55" fill="#a67242"/>
  <polygon points="78,75 92,35 108,75" fill="#a67242"/>
  <polygon points="132,75 148,35 162,75" fill="#a67242"/>
  <polygon points="84,68 92,48 100,68" fill="#f4a8b3"/>
  <polygon points="140,68 148,48 156,68" fill="#f4a8b3"/>
  <circle cx="100" cy="108" r="7" fill="#1a1a1a"/>
  <circle cx="140" cy="108" r="7" fill="#1a1a1a"/>
  <circle cx="102" cy="106" r="2" fill="#fff"/>
  <circle cx="142" cy="106" r="2" fill="#fff"/>
  <polygon points="115,125 125,125 120,133" fill="#3a1a1a"/>
  <path d="M120 133 Q112 142 104 140 M120 133 Q128 142 136 140"
        stroke="#1a1a1a" stroke-width="2" fill="none" stroke-linecap="round"/>
  <line x1="92"  y1="125" x2="60"  y2="118" stroke="#1a1a1a" stroke-width="1.5"/>
  <line x1="92"  y1="130" x2="60"  y2="132" stroke="#1a1a1a" stroke-width="1.5"/>
  <line x1="148" y1="125" x2="180" y2="118" stroke="#1a1a1a" stroke-width="1.5"/>
  <line x1="148" y1="130" x2="180" y2="132" stroke="#1a1a1a" stroke-width="1.5"/>
  <path d="M185 175 Q215 160 205 130" stroke="#a67242" stroke-width="14"
        fill="none" stroke-linecap="round"/>
  <text x="120" y="225" text-anchor="middle" font-family="monospace"
        font-size="11" fill="#7a5a3a">paid with PIVX via HTTP 402</text>
</svg>
`;

const app = express();

app.get(
  "/cat",
  pivx402({
    backend: makeBackend(),
    network: NETWORK,
    scheme: SCHEME,
    minConfirmations: Number(process.env.MIN_CONFIRMATIONS ?? 1),
    price: {
      amount: PRICE,
      payTo: PAY_TO,
      description: `one (1) cat picture (${SCHEME})`,
    },
  }),
  (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(CAT_SVG);
  },
);

app.get("/", (_req, res) => {
  res.json({
    try: "GET /cat",
    priceInPiv: PRICE,
    scheme: SCHEME,
    network: NETWORK,
    payTo: PAY_TO,
    note:
      SCHEME === "pivx-shield"
        ? "include the nonce as the memo on the shielded output"
        : "include the nonce as an OP_RETURN on the payment tx",
  });
});

app.listen(PORT, () => {
  console.log(`pivx402 cat demo listening on http://127.0.0.1:${PORT}`);
  console.log(`  GET /cat -> ${PRICE} PIV (${SCHEME}) to ${PAY_TO}`);
});
