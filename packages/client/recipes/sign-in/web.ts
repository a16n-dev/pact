import type { Store } from '@a16n/pact-client';

// Browser sign-in: send the user to the server's login page, then finish on
// the page `redirectUri` points at. Register that URI for the app on the
// server; `http://localhost` is matched on any port for local development.

export async function startSignIn(
  store: Store,
  options: { url: string; appId: string; deviceName: string }
): Promise<void> {
  const redirectUri = `${window.location.origin}/auth/callback`;
  const { authorizeUrl } = await store.sync.beginSignIn({ ...options, redirectUri });
  window.location.assign(authorizeUrl);
}

/** Call on the callback page. Returns false when the URL carries no sign-in result. */
export async function finishSignIn(store: Store): Promise<boolean> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return false;
  const result = await store.sync.completeSignIn({ code, state });
  if (!result.ok) throw new Error(`Sign-in failed: ${result.reason}`);
  // Drop the single-use code from the address bar so a reload does not retry it.
  window.history.replaceState(null, '', window.location.pathname);
  return true;
}
