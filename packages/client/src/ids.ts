import { customAlphabet } from 'nanoid';

// Alphanumerics only — deliberately excludes nanoid's default `_` and `-` so
// that `-` can serve as the prefix separator in the id scheme (`r-AbCd12XY`)
// without ever appearing in the random part. Every character here is an
// RFC-3986 unreserved char, so ids drop into URL paths and query strings
// untouched (no percent-encoding).
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const generate = customAlphabet(ALPHABET, 10);

/** A random, URL-safe id body of `length` characters (default 10). */
export const randomId = (length = 10): string => generate(length);
