import { useEffect, useRef, useState } from 'react';
import { usePactSync } from './syncHooks';

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
  const { completeSignIn } = usePactSync();
  const [settled, setSettled] = useState<{ code: string; result: SignInCallbackStatus } | null>(
    null
  );
  // The code is single-use, and StrictMode runs this effect twice.
  const sentCode = useRef<string | null>(null);

  useEffect(() => {
    if (!code || !state || sentCode.current === code) return;
    sentCode.current = code;
    completeSignIn({ code, state }).then(
      () => setSettled({ code, result: { status: 'success' } }),
      (error: unknown) =>
        setSettled({
          code,
          result: {
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          },
        })
    );
  }, [code, state, completeSignIn]);

  if (!code || !state) return { status: 'idle' };
  if (settled?.code === code) return settled.result;
  return { status: 'pending' };
}
