import type { z } from 'zod';

export type CredentialPlacement =
  | { in: 'header'; name: string; prefix?: string }
  | { in: 'query'; name: string };

export type CredentialField = CredentialPlacement & {
  /** Validates the value in `setCredentials`; also what an app's credentials form can check against. */
  schema: z.ZodType<string>;
};

export type ApiRequest = {
  /** Defaults to `GET`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Starts with `/`, relative to the API's `baseUrl`, and must stay under it. */
  path: string;
  /** `undefined` values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
};

export type ApiMethod<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> = {
  request: Req;
  /** Parses the response body: JSON when the API says so, otherwise text, or `undefined` when empty. */
  response: Res;
  build(input: z.output<Req>): ApiRequest;
};

export type ApiDefinition<
  Credentials extends Record<string, CredentialField> = Record<string, CredentialField>,
  Methods extends Record<string, ApiMethod<any, any>> = Record<string, ApiMethod<any, any>>,
> = {
  name: string;
  baseUrl: string;
  credentials: Credentials;
  methods: Methods;
};

export type CredentialValues<Api extends ApiDefinition> = {
  [K in keyof Api['credentials']]: z.input<Api['credentials'][K]['schema']>;
};

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const FIELD_RE = /^[A-Za-z0-9_]{1,64}$/;

/** Wraps each entry in `defineApi`'s `methods`, so `build` gets its input typed from `request`. */
export function apiMethod<Req extends z.ZodType, Res extends z.ZodType>(
  method: ApiMethod<Req, Res>
): ApiMethod<Req, Res> {
  return method;
}

export function defineApi<
  Credentials extends Record<string, CredentialField>,
  Methods extends Record<string, ApiMethod<any, any>>,
>(config: {
  /** Credentials are stored on the server under this name, so renaming orphans them. */
  name: string;
  /**
   * An https URL. Credentials are saved for this exact URL and the server
   * only sends them under it, so changing it means setting them again.
   */
  baseUrl: string;
  credentials: Credentials;
  /** Each wrapped in `apiMethod`. */
  methods: Methods;
}): ApiDefinition<Credentials, Methods> {
  if (!NAME_RE.test(config.name)) {
    throw new Error(`API name "${config.name}" must be 1–64 letters, digits, _, . or -`);
  }
  if (!isHttpsBase(config.baseUrl)) {
    throw new Error(`API "${config.name}" needs an https baseUrl without a query or fragment`);
  }
  const fields = Object.keys(config.credentials);
  if (fields.length === 0 || fields.length > 16 || !fields.every((f) => FIELD_RE.test(f))) {
    throw new Error(`API "${config.name}" needs 1–16 credentials named with letters, digits and _`);
  }
  return config;
}

// Not `URL.canParse`, which Hermes (React Native) lacks.
function isHttpsBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.search && !url.hash;
  } catch {
    return false;
  }
}
