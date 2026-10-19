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

export function allowedOrigins(registered: string[]): Set<string> {
  const origins = new Set<string>();
  for (const uri of registered) {
    try {
      const url = new URL(uri);
      if (url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // Unparseable URIs can't match anything anyway.
    }
  }
  return origins;
}
