import type { Store } from '@a16n/pact-client';

// Expo sign-in with `expo-auth-session` and `expo-web-browser`: the server's
// login page opens in the system browser and returns to the app on a
// private-use scheme redirect such as `com.example.app:/auth`. Register
// that exact URI for the app on the server, and set `scheme` in app.json.
//
// Declared structurally so this file typechecks without the Expo packages
// installed; in an app, import `makeRedirectUri` from 'expo-auth-session'
// and `openAuthSessionAsync` from 'expo-web-browser'.
type AuthSession = {
  makeRedirectUri(options: { scheme: string; path: string }): string;
  openAuthSessionAsync(
    url: string,
    redirectUri: string
  ): Promise<{ type: 'success'; url: string } | { type: string }>;
};

export async function signInWithExpo(
  store: Store,
  auth: AuthSession,
  options: { url: string; appId: string; deviceName: string; scheme: string }
): Promise<boolean> {
  const redirectUri = auth.makeRedirectUri({ scheme: options.scheme, path: 'auth' });
  const { authorizeUrl } = await store.sync.beginSignIn({
    url: options.url,
    appId: options.appId,
    deviceName: options.deviceName,
    redirectUri,
  });
  const result = await auth.openAuthSessionAsync(authorizeUrl, redirectUri);
  if (result.type !== 'success' || !('url' in result)) return false;
  const params = new URL(result.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return false;
  const completed = await store.sync.completeSignIn({ code, state });
  if (!completed.ok) throw new Error(`Sign-in failed: ${completed.reason}`);
  return true;
}
