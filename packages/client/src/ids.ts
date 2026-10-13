import { customAlphabet } from 'nanoid';

// Drops nanoid's default `_` and `-` so `-` is free to separate prefix from
// body in document ids; every remaining character is RFC 3986 unreserved, so
// ids need no percent-encoding in URLs.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const generate = customAlphabet(ALPHABET, 10);

export const randomId = (length = 10): string => generate(length);
