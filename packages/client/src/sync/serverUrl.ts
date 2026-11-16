/** Trims the input and takes a bare host, such as `sync.example.com`, to mean `https://`. */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
