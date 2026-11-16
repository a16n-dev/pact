import { useEffect, useRef } from 'react';
import { useCompleteSignIn } from './syncHooks';

export type SignInCallbackStatus =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'error'; error: Error };

/**
 * Completes sign-in from the redirect's query parameters, once per code.
 * `idle` while either parameter is missing; the app decides what to show.
 * An error is a `SignInError` when the server refused the code.
 */
export function useSignInCallback(params: {
  code: string | null | undefined;
  state: string | null | undefined;
}): SignInCallbackStatus {
  const { code, state } = params;
  const { mutate, status, error } = useCompleteSignIn();
  // The code is single-use, and StrictMode runs this effect twice.
  const sentCode = useRef<string | null>(null);

  useEffect(() => {
    if (!code || !state || sentCode.current === code) return;
    sentCode.current = code;
    mutate({ code, state });
  }, [code, state, mutate]);

  if (!code || !state) return { status: 'idle' };
  if (status === 'error') return { status, error };
  if (status === 'success') return { status };
  return { status: 'pending' };
}
