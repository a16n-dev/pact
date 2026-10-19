import { fromBase64url } from '../lib/crypto';

type AccessJwk = JsonWebKey & {
  kid: string;
};

let cachedCerts: { teamDomain: string; keys: AccessJwk[]; fetchedAt: number } | null = null;
const CERTS_TTL_MS = 60 * 60_000;

async function fetchKeys(teamDomain: string): Promise<AccessJwk[]> {
  const now = Date.now();
  if (cachedCerts?.teamDomain === teamDomain && now - cachedCerts.fetchedAt < CERTS_TTL_MS) {
    return cachedCerts.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs request failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: AccessJwk[] };
  cachedCerts = { teamDomain, keys, fetchedAt: now };
  return keys;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromBase64url(segment)));
}

// Verifies a Cloudflare Access application token (RS256) against the team's published JWKs.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
export async function verifyAccessJwt(
  jwt: string | undefined,
  teamDomain: string,
  aud: string
): Promise<boolean> {
  if (!jwt || !teamDomain || !aud) return false;
  const [headerSeg, payloadSeg, signatureSeg] = jwt.split('.');
  if (!headerSeg || !payloadSeg || !signatureSeg) return false;
  try {
    const header = decodeJson(headerSeg);
    const payload = decodeJson(payloadSeg);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false;

    const jwk = (await fetchKeys(teamDomain)).find((key) => key.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      fromBase64url(signatureSeg) as BufferSource,
      new TextEncoder().encode(`${headerSeg}.${payloadSeg}`)
    );
    if (!valid) return false;

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return false;
    if (payload.iss !== `https://${teamDomain}`) return false;
    return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
