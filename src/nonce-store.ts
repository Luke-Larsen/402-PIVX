export interface NonceStore {
  /** Returns true if claimed by this caller; false if already used. */
  claim(nonce: string): Promise<boolean>;
}

/** In-memory store. Fine for a single process; swap for Redis in production. */
export class InMemoryNonceStore implements NonceStore {
  private readonly used = new Map<string, number>();
  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  async claim(nonce: string): Promise<boolean> {
    this.sweep();
    if (this.used.has(nonce)) return false;
    this.used.set(nonce, Date.now());
    return true;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, t] of this.used) if (t < cutoff) this.used.delete(k);
  }
}

export function randomNonce(): string {
  // 16 bytes hex -> 32 chars. Fits in a single OP_RETURN push easily.
  const bytes = new Uint8Array(16);
  // crypto.getRandomValues is available in Node 19+ via the global crypto object.
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
