import type { PivxBackend } from "./backends";
import type { NonceStore } from "./nonce-store";
import { pivToSats } from "./amount";
import type {
  PaymentProof,
  PaymentRequirement,
  VerificationResult,
} from "./types";

export interface VerifierOptions {
  backend: PivxBackend;
  nonceStore: NonceStore;
}

export class Verifier {
  constructor(private readonly opts: VerifierOptions) {}

  async verify(
    requirement: PaymentRequirement,
    proof: PaymentProof,
  ): Promise<VerificationResult> {
    if (proof.scheme !== requirement.scheme) {
      return { ok: false, reason: "scheme_unsupported", details: `proof scheme ${proof.scheme} != ${requirement.scheme}` };
    }
    if (proof.network !== requirement.network) {
      return { ok: false, reason: "network_mismatch" };
    }
    if (proof.payload.nonce !== requirement.nonce) {
      return { ok: false, reason: "missing_nonce", details: "proof nonce does not match requirement" };
    }

    const onChain =
      requirement.scheme === "pivx-transparent"
        ? await this.verifyTransparent(requirement, proof)
        : requirement.scheme === "pivx-shield"
          ? await this.verifyShielded(requirement, proof)
          : { ok: false as const, reason: "scheme_unsupported" as const };

    if (!onChain.ok) return onChain;

    // Replay protection: claim the nonce only once, after all other checks pass.
    const claimed = await this.opts.nonceStore.claim(requirement.nonce);
    if (!claimed) return { ok: false, reason: "nonce_replayed" };
    return { ok: true };
  }

  private async verifyTransparent(
    requirement: PaymentRequirement,
    proof: PaymentProof,
  ): Promise<VerificationResult> {
    const tx = await this.opts.backend.getTransaction(proof.payload.txid);
    if (!tx) return { ok: false, reason: "tx_not_found" };

    if (tx.confirmations < requirement.minConfirmations) {
      return {
        ok: false,
        reason: "insufficient_confirmations",
        details: `have ${tx.confirmations}, need ${requirement.minConfirmations}`,
      };
    }

    const required = pivToSats(requirement.maxAmountRequired);
    const paid = tx.outputs
      .filter((o) => o.address === requirement.payTo && o.value !== null)
      .reduce((acc, o) => acc + pivToSats(o.value as string), 0n);

    if (paid === 0n) return { ok: false, reason: "wrong_recipient" };
    if (paid < required) {
      return {
        ok: false,
        reason: "insufficient_amount",
        details: `paid ${paid} sats, need ${required} sats`,
      };
    }

    const hasNonce = tx.outputs.some((o) => o.opReturnText === requirement.nonce);
    if (!hasNonce) return { ok: false, reason: "missing_nonce", details: "OP_RETURN with nonce not found" };

    return { ok: true };
  }

  private async verifyShielded(
    requirement: PaymentRequirement,
    proof: PaymentProof,
  ): Promise<VerificationResult> {
    if (!this.opts.backend.viewShieldedTransaction) {
      return {
        ok: false,
        reason: "shielded_backend_unavailable",
        details: "configured backend cannot decrypt shielded outputs",
      };
    }

    const tx = await this.opts.backend.viewShieldedTransaction(proof.payload.txid);
    if (!tx) return { ok: false, reason: "tx_not_found" };

    if (tx.confirmations < requirement.minConfirmations) {
      return {
        ok: false,
        reason: "insufficient_confirmations",
        details: `have ${tx.confirmations}, need ${requirement.minConfirmations}`,
      };
    }

    // Only consider incoming (non-outgoing) outputs to our shielded address.
    const incoming = tx.shieldedOutputs.filter(
      (o) => !o.outgoing && o.address === requirement.payTo,
    );
    if (incoming.length === 0) return { ok: false, reason: "wrong_recipient" };

    const required = pivToSats(requirement.maxAmountRequired);
    // Match an output whose memo carries the nonce; aggregate its value.
    const matching = incoming.filter((o) => o.memoText === requirement.nonce);
    if (matching.length === 0) {
      return { ok: false, reason: "missing_nonce", details: "no shielded output with the nonce in its memo" };
    }
    const paid = matching.reduce((acc, o) => acc + pivToSats(o.value), 0n);
    if (paid < required) {
      return {
        ok: false,
        reason: "insufficient_amount",
        details: `paid ${paid} sats, need ${required} sats`,
      };
    }

    return { ok: true };
  }
}
