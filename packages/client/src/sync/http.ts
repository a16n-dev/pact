const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * `fetch` with a hard timeout. Without one, a stalled server (no response, a
 * half-open socket) hangs sync indefinitely. Uses AbortController + setTimeout
 * rather than `AbortSignal.timeout` for React Native / Hermes compatibility.
 * Aborting rejects the fetch, which callers already treat as a failed request.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
