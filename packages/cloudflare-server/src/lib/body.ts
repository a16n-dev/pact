// Reads the body in chunks so an oversized response is refused before it fills the Worker's
// memory. Null when the body is over `maxBytes`.
export async function readCapped(
  res: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(res.headers.get('content-length')) > maxBytes) return null;
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let sizeBytes = 0;
  for await (const chunk of res.body) {
    sizeBytes += chunk.byteLength;
    if (sizeBytes > maxBytes) return null;
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
