const DEFAULT_TIMEOUT_MS = 15_000;

// A stalled server would otherwise hang sync indefinitely. AbortController +
// setTimeout rather than AbortSignal.timeout, which Hermes (React Native) lacks.
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
