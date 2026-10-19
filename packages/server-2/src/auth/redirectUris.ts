const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

function isLoopback(url: URL): boolean {
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
  if (url.protocol === 'http:') return isLoopback(url);
  // Private-use schemes for native apps (RFC 8252 §7.1), such as `com.example.app:/callback`.
  return url.protocol.includes('.') && !url.protocol.startsWith('.');
}

// Exact string comparison, except that a registered loopback URI matches on any port so local
// dev servers can pick whatever port is free (RFC 8252 §7.3).
export function redirectUriMatches(registered: string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let url: URL;
  try {
    url = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopback(url)) return false;
  return registered.some((uri) => {
    let candidate: URL;
    try {
      candidate = new URL(uri);
    } catch {
      return false;
    }
    if (!isLoopback(candidate)) return false;
    candidate.port = url.port;
    return candidate.href === url.href;
  });
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
