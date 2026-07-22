// Dependency-free base64, because pact-client must run where neither Node's
// Buffer nor the browser's btoa/atob is guaranteed (e.g. React Native Hermes).

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REVERSE: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i += 1) REVERSE[ALPHABET[i]!] = i;

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : '=';
    out += i + 2 < bytes.length ? ALPHABET[c & 63]! : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].map((j) => {
      const ch = clean[i + j];
      if (ch === undefined) return 0;
      const v = REVERSE[ch];
      if (v === undefined) throw new Error('Invalid base64');
      return v;
    }) as [number, number, number, number];
    const chunk = (n[0] << 18) | (n[1] << 12) | (n[2] << 6) | n[3];
    const remaining = clean.length - i;
    out[o++] = (chunk >> 16) & 0xff;
    if (remaining > 2) out[o++] = (chunk >> 8) & 0xff;
    if (remaining > 3) out[o++] = chunk & 0xff;
  }
  return out;
}
