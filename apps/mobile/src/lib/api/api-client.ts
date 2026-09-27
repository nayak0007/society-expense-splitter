import type { ZodType } from 'zod';

import { config } from '@/constants/config';
import { getSupabaseClient, getSupabaseSession } from '@/lib/supabase/supabase.client';

/**
 * The one place the mobile app talks to the Resident 360 API.
 *
 * ## Why the app calls the API at all
 *
 * Supabase is the infrastructure, not the boundary: the anon key ships in the
 * bundle, so anyone can call PostgREST directly. Going through `/v1` puts the
 * rules, the idempotency handling and the error catalogue behind a surface the
 * server owns, and lets a table constraint change without shipping an app.
 *
 * ## The session is the authorisation
 *
 * Every request carries the Supabase access token. The API verifies it against
 * the project's JWKS — the same token, verified the same way, by the same
 * project — and derives the tenant identity from the `sub` claim, so no request
 * body or query ever names a user. A caller cannot ask for someone else's rows
 * because the caller never gets to say who they are.
 *
 * `anonymous: true` is only for genuinely public routes (the join-code preview,
 * which must resolve before the user has joined anything). It sends no
 * `Authorization` header at all rather than an empty one.
 *
 * ## 401 → silent refresh → replay once → give up
 *
 * SAD §7.9's client rule, implemented here rather than at each call site. A 401
 * with a locally-valid session means the access token expired between the
 * client's last refresh and this request; refreshing and replaying is invisible
 * to the user and is the difference between a working app and a random logout.
 * Only if the second attempt also fails does the error escape — and by then
 * supabase-js has already cleared the session, so `onAuthStateChange` routes to
 * sign-in.
 */

/** SAD §7.10's error body, as the API sends it. */
export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  readonly details?:
    | readonly {
        readonly field: string;
        readonly code: string;
        readonly message: string;
      }[]
    | undefined;
  readonly requestId?: string;
  readonly timestamp?: string;
}

/**
 * A failed API call.
 *
 * `code` is the contract's machine-readable catalogue value — the field clients
 * branch on — and is deliberately a plain `string` rather than the enum: a
 * server that adds a code must not break an older client, and an unknown code
 * has to fall through to a sane default instead of failing to parse. `NETWORK`
 * is the one value this client invents, for a failure that never reached the
 * server (no response, so no catalogue code to report).
 *
 * `field` is the SAD §7.10 top-level field path, and it is surfaced separately
 * from `details` because the two are not interchangeable: the API sets `details`
 * only when a failure produces structured per-field issues, while a single
 * rejected value — a duplicate name, an out-of-range floor count — arrives as
 * `field` alone. A client that read only `details` would drop exactly the case a
 * form most needs to highlight, so this is resolved from either.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string | undefined,
    readonly details?: ApiErrorBody['details'],
    override readonly cause?: unknown,
    /** Field path the failure belongs to, when the server named one. */
    readonly field?: string | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** True when the failure reached the server but was refused. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** A failure that never reached the server — offline, DNS, timeout. */
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NETWORK';
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions<TValue> {
  readonly body?: unknown;
  /** Contract schema for the envelope's `data`, so a shape change is caught here. */
  readonly schema?: ZodType<TValue>;
  readonly signal?: AbortSignal;
  /** Send no Authorization header (public routes only). */
  readonly anonymous?: boolean;
  /**
   * The society the call is scoped to, sent as `X-Society-Id`.
   *
   * Only header-scoped routes take this — the ones whose controller declares an
   * `@RequirePermission(…)`, which is what puts them behind
   * `SocietyGuard`/`PermissionGuard`. The guard resolves the header into the one
   * membership the request may act under, so a route given no header answers `400`
   * and one given a society the caller is not in answers `404`.
   *
   * Not to be confused with the path-scoped society routes
   * (`/societies/:societyId`), which name their tenant in the URL and must not also
   * carry a header — two sources for one scope is how a request ends up
   * authorised against one society and reading another.
   */
  readonly societyId?: string;
}

/**
 * `config.apiUrl` already includes the version segment
 * (`http://localhost:3000/v1`), so a path here starts with the resource.
 */
function url(path: string): string {
  return `${config.apiUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function accessToken(): Promise<string | null> {
  const session = await getSupabaseSession();
  return session?.access_token ?? null;
}

async function readError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body from a proxy or a crash: the status is all we have.
  }

  const envelope = (body ?? {}) as { readonly error?: ApiErrorBody };
  const error = envelope.error;

  // `cause` is passed as `undefined` rather than omitted, because `field` follows
  // it: the parameter is last so the `NETWORK` constructions elsewhere — which do
  // pass a real cause — keep their meaning. Reading the field from either place is
  // deliberate; see the note on `ApiError.field`.
  return new ApiError(
    response.status,
    error?.code ?? `${response.status}`,
    error?.message ?? `Request failed with status ${response.status}.`,
    error?.requestId,
    error?.details,
    undefined,
    error?.field ?? error?.details?.[0]?.field,
  );
}

async function send(
  method: HttpMethod,
  path: string,
  token: string | null,
  options: ApiRequestOptions<unknown>,
): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  // Only when there is a body: Fastify rejects a declared JSON content-type with
  // an empty payload, which turns a legitimate 204 route into a 400.
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.societyId !== undefined) headers['x-society-id'] = options.societyId;

  return fetch(url(path), {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

export async function apiRequest<TValue>(
  method: HttpMethod,
  path: string,
  options: ApiRequestOptions<TValue> = {},
): Promise<TValue> {
  const token = options.anonymous === true ? null : await accessToken();

  if (options.anonymous !== true && token === null) {
    // No session at all: don't spend a round trip to be told so.
    throw new ApiError(401, 'UNAUTHENTICATED', 'You are not signed in.');
  }

  let response: Response;
  try {
    response = await send(method, path, token, options);
  } catch (error: unknown) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server.', undefined, undefined, error);
  }

  if (response.status === 401 && options.anonymous !== true) {
    // The token may simply have expired mid-session; SAD §7.9 replays once after
    // a silent refresh before treating this as a logout.
    const refreshed = await getSupabaseClient().auth.refreshSession();
    const next = refreshed.data.session?.access_token ?? null;
    if (next !== null) {
      try {
        response = await send(method, path, next, options);
      } catch (error: unknown) {
        throw new ApiError(
          0,
          'NETWORK',
          'Could not reach the server.',
          undefined,
          undefined,
          error,
        );
      }
    }
  }

  if (!response.ok) throw await readError(response);

  // 204 has no body — and no envelope.
  if (response.status === 204) return undefined as TValue;

  const text = await response.text();
  const envelope = (text.length === 0 ? {} : JSON.parse(text)) as {
    readonly data?: unknown;
  };

  const data = envelope.data;
  return options.schema === undefined ? (data as TValue) : options.schema.parse(data);
}
