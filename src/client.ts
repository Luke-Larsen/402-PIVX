import { decodeRequirements, encodeProof, HEADER_PAYMENT, HEADER_PAYMENT_REQUIRED } from "./headers";
import type { PaymentProof, PaymentRequirement } from "./types";

/**
 * A function that pays a payment requirement and returns the broadcast txid.
 *
 * Implementations are responsible for:
 *   - constructing a PIVX transaction that pays `req.maxAmountRequired` PIV to `req.payTo`
 *   - embedding `req.nonce` (as OP_RETURN for transparent, as the memo for shield)
 *   - broadcasting it
 *
 * AI agents typically supply a payer that calls into a wallet, custodian, or signer.
 */
export type Payer = (req: PaymentRequirement) => Promise<string>;

export interface PayAndFetchOptions {
  /** Request init forwarded to fetch (method, headers, body, etc.). */
  init?: RequestInit;
  /** Optional fetch override (for tests or non-browser runtimes). */
  fetchImpl?: typeof fetch;
  /**
   * Choose a payment requirement when the server advertises more than one.
   * Default: pick the first.
   */
  pickRequirement?: (accepts: PaymentRequirement[]) => PaymentRequirement;
}

export interface PayAndFetchResult {
  response: Response;
  requirement: PaymentRequirement;
  txid: string;
}

/**
 * Fetch a 402-gated URL, paying it through the supplied `payer` if required.
 *
 * Flow:
 *   1. GET the URL.
 *   2. If 200, return immediately (no payment needed).
 *   3. If 402, decode the X-Payment-Required header, hand the requirement to
 *      the payer, and retry the request with X-Payment set to the proof.
 *
 * Any other status surfaces directly on the returned `response`.
 */
export async function payAndFetch(
  url: string,
  payer: Payer,
  opts: PayAndFetchOptions = {},
): Promise<PayAndFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const first = await fetchImpl(url, opts.init);
  if (first.status !== 402) {
    return { response: first, requirement: emptyRequirement(), txid: "" };
  }

  const header = first.headers.get(HEADER_PAYMENT_REQUIRED.toLowerCase());
  if (!header) {
    throw new Error(`server returned 402 with no ${HEADER_PAYMENT_REQUIRED} header`);
  }
  // Drain so the connection can be reused.
  await first.arrayBuffer();

  const envelope = decodeRequirements(header);
  if (!envelope.accepts.length) {
    throw new Error("X-Payment-Required envelope has no accepted payment options");
  }
  const requirement = opts.pickRequirement
    ? opts.pickRequirement(envelope.accepts)
    : envelope.accepts[0];

  const txid = await payer(requirement);
  if (!txid) throw new Error("payer returned an empty txid");

  const proof: PaymentProof = {
    x402Version: 1,
    scheme: requirement.scheme,
    network: requirement.network,
    payload: { txid, nonce: requirement.nonce },
  };
  const init: RequestInit = {
    ...(opts.init ?? {}),
    headers: {
      ...((opts.init?.headers as Record<string, string>) ?? {}),
      [HEADER_PAYMENT]: encodeProof(proof),
    },
  };

  const response = await fetchImpl(url, init);
  return { response, requirement, txid };
}

function emptyRequirement(): PaymentRequirement {
  return {
    scheme: "pivx-transparent",
    network: "pivx-mainnet",
    asset: "PIV",
    maxAmountRequired: "0",
    payTo: "",
    nonce: "",
    minConfirmations: 0,
    maxTimeoutSeconds: 0,
    resource: "",
  };
}
