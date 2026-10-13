import type { MiddlewareHandler } from 'hono';

/**
 * The sync protocol this server speaks, advertised on `GET /info`. Bumped
 * whenever the wire contract changes in a way an older client would get
 * wrong rather than merely miss out on. v4: per-client document rows folded
 * on the client, app-wide pull cursor.
 */
export const PROTOCOL_VERSION = 4;

/**
 * The oldest client protocol this server still serves. Equal to
 * `PROTOCOL_VERSION` while there's no compatibility window; widen the gap
 * only when a newer server deliberately keeps older clients working.
 */
export const MIN_PROTOCOL_VERSION = 4;

/** Request header a client uses to declare the protocol it speaks. */
export const PROTOCOL_HEADER = 'x-pact-protocol';

/**
 * Refuses requests from clients that don't declare a protocol version in
 * range, with a 426 the client can turn into an "upgrade" message. A
 * missing header is treated as too old: clients predating the header are
 * exactly the ones that would misread this server's responses.
 */
export const requireProtocol: MiddlewareHandler = async (c, next) => {
  const declared = Number(c.req.header(PROTOCOL_HEADER));
  if (!Number.isInteger(declared) || declared < MIN_PROTOCOL_VERSION) {
    return c.json(
      {
        error: `Client protocol ${Number.isInteger(declared) ? declared : 'unknown'} is below this server's minimum ${MIN_PROTOCOL_VERSION}. Upgrade the app.`,
        code: 'protocol_unsupported',
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
      },
      426
    );
  }
  if (declared > PROTOCOL_VERSION) {
    return c.json(
      {
        error: `Client protocol ${declared} is newer than this server's ${PROTOCOL_VERSION}. Upgrade the server.`,
        code: 'protocol_unsupported',
        protocolVersion: PROTOCOL_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
      },
      426
    );
  }
  await next();
};
