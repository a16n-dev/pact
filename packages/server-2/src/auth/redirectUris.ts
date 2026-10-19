const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isLoopbackUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export function isAllowedRedirectUriForm(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') return isLoopbackUri(uri);
  // Private-use schemes for native apps (RFC 8252 §7.1), such as `com.example.app:/callback`.
  return url.protocol.includes('.') && !url.protocol.startsWith('.');
}

// Exact string comparison against the registered URIs, or any loopback URI on any port when the
// app allows localhost (RFC 8252 §7.3).
export function redirectUriMatches(
  app: { allow_localhost: number },
  registered: string[],
  requested: string
): boolean {
  if (registered.includes(requested)) return true;
  return app.allow_localhost === 1 && isLoopbackUri(requested);
}

// The https origin an entered domain or redirect URI resolves to, or null when it has none.
export function parseHttpsOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
  return url.origin;
}
