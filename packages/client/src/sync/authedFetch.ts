import { SyncError, UnauthorizedError, failed } from './http';

type Credentials = { url: string; token: string };

export type AuthedFetchDeps = {
  credentials(): Promise<Credentials | null>;
  onUnauthorized(): void;
};

// No timeout: an AI or third-party call can take well over a minute. Callers cancel with a signal.
export function authedFetch(
  deps: AuthedFetchDeps,
  signedOutMessage: string
): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init = {}) => {
    const creds = await deps.credentials();
    if (!creds) throw new SyncError(401, 'signed_out', signedOutMessage);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${creds.token}`);
    const res = await fetch(`${creds.url}${path}`, { ...init, headers });
    if (res.ok) return res;
    try {
      return await failed(res);
    } catch (error) {
      if (error instanceof UnauthorizedError) deps.onUnauthorized();
      throw error;
    }
  };
}
