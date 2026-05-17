import type { Request, RequestHandler, Response } from "express";
import { HEADER_PAYMENT, HEADER_PAYMENT_REQUIRED, decodeProof, encodeRequirements } from "./headers";
import { InMemoryNonceStore, randomNonce, type NonceStore } from "./nonce-store";
import { Verifier } from "./verifier";
import type { PivxBackend } from "./backends";
import type { Network, PaymentProof, PaymentRequirement, Scheme } from "./types";

export interface PriceConfig {
  /** Decimal PIV, e.g. "0.01". */
  amount: string;
  /** Receiving PIVX address. */
  payTo: string;
  description?: string;
}

/**
 * Per-request price, returned either synchronously or asynchronously.
 * Use the async form when the price depends on a database/external lookup.
 */
export type PriceResolver = (req: Request) => PriceConfig | Promise<PriceConfig>;

export interface MiddlewareOptions {
  backend: PivxBackend;
  network: Network;
  scheme?: Scheme;
  minConfirmations?: number;
  maxTimeoutSeconds?: number;
  /** Static price, or a per-request function (may be async). */
  price: PriceConfig | PriceResolver;
  nonceStore?: NonceStore;
}

/** Data the middleware attaches to a successful request before next(). */
export interface Pivx402RequestContext {
  txid: string;
  nonce: string;
  scheme: Scheme;
  network: Network;
  amount: string;
  payTo: string;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by the pivx402 middleware after a successful payment verification. */
    pivx402?: Pivx402RequestContext;
  }
}

export function pivx402(opts: MiddlewareOptions): RequestHandler {
  const scheme: Scheme = opts.scheme ?? "pivx-transparent";
  const nonceStore = opts.nonceStore ?? new InMemoryNonceStore();
  const verifier = new Verifier({ backend: opts.backend, nonceStore });

  return async (req, res, next) => {
    const price = await (typeof opts.price === "function" ? opts.price(req) : opts.price);
    const header = req.header(HEADER_PAYMENT);

    if (!header) {
      return sendPaymentRequired(res, {
        scheme,
        network: opts.network,
        asset: "PIV",
        maxAmountRequired: price.amount,
        payTo: price.payTo,
        nonce: randomNonce(),
        minConfirmations: opts.minConfirmations ?? 1,
        maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
        resource: req.originalUrl ?? req.url,
        description: price.description,
      });
    }

    let proof: PaymentProof;
    try {
      proof = decodeProof(header);
    } catch (err) {
      return res.status(400).json({ error: "malformed_payment_header" });
    }

    // Reconstruct the requirement from the proof's nonce + current price.
    // The nonce came from a prior 402 we issued; the client echoes it back.
    const requirement: PaymentRequirement = {
      scheme,
      network: opts.network,
      asset: "PIV",
      maxAmountRequired: price.amount,
      payTo: price.payTo,
      nonce: proof.payload.nonce,
      minConfirmations: opts.minConfirmations ?? 1,
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 600,
      resource: req.originalUrl ?? req.url,
      description: price.description,
    };

    const result = await verifier.verify(requirement, proof);
    if (!result.ok) {
      return sendPaymentRequired(
        res,
        { ...requirement, nonce: randomNonce() },
        `${result.reason}${result.details ? `: ${result.details}` : ""}`,
      );
    }
    req.pivx402 = {
      txid: proof.payload.txid,
      nonce: requirement.nonce,
      scheme: requirement.scheme,
      network: requirement.network,
      amount: requirement.maxAmountRequired,
      payTo: requirement.payTo,
    };
    return next();
  };
}

function sendPaymentRequired(res: Response, req: PaymentRequirement, error?: string) {
  res
    .status(402)
    .setHeader(
      HEADER_PAYMENT_REQUIRED,
      encodeRequirements({ x402Version: 1, accepts: [req], error }),
    )
    .json({
      x402Version: 1,
      accepts: [req],
      ...(error ? { error } : {}),
    });
}
