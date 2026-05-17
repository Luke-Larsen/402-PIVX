const PIV_DECIMALS = 8;

export function pivToSats(piv: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(piv)) {
    throw new Error(`invalid PIV amount: ${piv}`);
  }
  const [whole, frac = ""] = piv.split(".");
  if (frac.length > PIV_DECIMALS) {
    throw new Error(`PIV amount has more than ${PIV_DECIMALS} decimals: ${piv}`);
  }
  const fracPadded = (frac + "0".repeat(PIV_DECIMALS)).slice(0, PIV_DECIMALS);
  return BigInt(whole) * 100_000_000n + BigInt(fracPadded);
}

export function satsToPiv(sats: bigint): string {
  const neg = sats < 0n;
  const abs = neg ? -sats : sats;
  const whole = abs / 100_000_000n;
  const frac = (abs % 100_000_000n).toString().padStart(PIV_DECIMALS, "0").replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${out}` : out;
}
