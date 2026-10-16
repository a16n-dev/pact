const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(
  secret: string | undefined,
  response: string | undefined,
  remoteIp: string | undefined
): Promise<boolean> {
  if (!secret || !response) return false;
  const body = new URLSearchParams({ secret, response });
  if (remoteIp) body.set('remoteip', remoteIp);
  try {
    const res = await fetch(VERIFY_URL, { method: 'POST', body });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}
