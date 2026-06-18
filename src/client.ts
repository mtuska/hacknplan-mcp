/**
 * Async HTTP client for the HacknPlan API v0.
 *
 * Encapsulates the behaviours verified live against the API:
 *  - Auth header `Authorization: ApiKey <key>`
 *  - Global rate-limit throttle (5 req/s) + retry on 429/5xx
 *  - Tolerance for BARE-ARRAY list responses (not a {items,total} envelope)
 *  - Empty-body 404 handling and the generic 400 "Invalid values object." message
 *  - Plain-scalar bodies (sub-task title string, tag/user id int) vs JSON-object bodies
 */

export const BASE_URL = "https://api.hacknplan.com/v0";
const MIN_INTERVAL_MS = 220; // >=5 req/s headroom (limit is 5/s per IP)
const MAX_RETRIES = 4;
const RETRY_BACKOFF_MS = [500, 1000, 2000, 4000];
const RETRY_JITTER_MS = 250; // random spread added to each backoff
const RETRY_AFTER_CAP_MS = 60_000; // never honor an absurd Retry-After
const TIMEOUT_MS = 30_000;

export type Json = unknown;

/** Raised on a non-retryable API error. `.status` + `.body` carry detail. */
export class HacknPlanError extends Error {
  readonly status: number;
  readonly body: Json;
  readonly httpMethod: string;
  readonly path: string;

  constructor(status: number, body: Json, method: string, path: string) {
    let msg: string;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const rec = body as Record<string, unknown>;
      msg = (rec.message as string) ?? "(empty body)";
      if (rec.modelState && typeof rec.modelState === "object") {
        msg = `${msg} ${JSON.stringify(rec.modelState)}`;
      }
    } else {
      msg = (body as string) || "(empty body)";
    }
    super(`${method} ${path} -> HTTP ${status}: ${msg}`);
    this.name = "HacknPlanError";
    this.status = status;
    this.body = body;
    this.httpMethod = method;
    this.path = path;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff for `attempt` (0-based) with a little random jitter. */
function backoffMs(attempt: number): number {
  const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
  return base + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/**
 * Wait implied by a `Retry-After` header, in ms, or null if absent/unparseable.
 * Supports both the delta-seconds form (`Retry-After: 5`) and the HTTP-date
 * form (`Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`).
 */
function retryAfterMs(resp: Response): number | null {
  const h = resp.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h.trim());
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return null;
}

/**
 * Thin async wrapper. One instance per server process; serializes calls through
 * a promise chain so the global rate-limit throttle is honored across tools.
 */
export class HacknPlanClient {
  private readonly key: string;
  private readonly base: string;
  private lastCall = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, baseUrl: string = BASE_URL) {
    if (!apiKey) throw new Error("HACKNPLAN_API_KEY is required");
    this.key = apiKey;
    this.base = baseUrl.replace(/\/+$/, "");
  }

  private async throttle(): Promise<void> {
    const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
    if (wait > 0) await sleep(wait);
    this.lastCall = Date.now();
  }

  /**
   * Perform one API call. `body` may be a plain object/array (JSON object) or a
   * bare string/number/boolean (HacknPlan uses scalar bodies for sub-tasks,
   * comments, tag/user attach). Returns parsed JSON or `null` for an empty 2xx
   * body. Throws HacknPlanError on a non-2xx, non-retryable status.
   *
   * Calls are serialized through an internal queue so the throttle applies
   * globally even when tools fire concurrently.
   */
  request(
    method: string,
    path: string,
    opts: { body?: Json; params?: Record<string, unknown> } = {},
  ): Promise<Json> {
    const run = () => this.doRequest(method, path, opts);
    const result = this.queue.then(run, run);
    // keep the queue chain alive regardless of this call's outcome
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async doRequest(
    method: string,
    path: string,
    opts: { body?: Json; params?: Record<string, unknown> },
  ): Promise<Json> {
    const url = new URL(this.base + path);
    if (opts.params) {
      for (const [k, v] of Object.entries(opts.params)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Authorization: `ApiKey ${this.key}`,
      Accept: "application/json",
    };
    let content: string | undefined;
    if (opts.body !== undefined && opts.body !== null) {
      content = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.throttle();

      let resp: Response | null = null;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        resp = await fetch(url, {
          method,
          headers,
          body: content,
          signal: ctrl.signal,
        });
      } catch (e) {
        lastErr = e;
        resp = null;
      } finally {
        clearTimeout(timer);
      }

      if (resp === null) {
        if (attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new HacknPlanError(0, `network error: ${String(lastErr)}`, method, path);
      }

      if (resp.status === 429 || resp.status >= 500) {
        if (attempt < MAX_RETRIES) {
          // On 429 honor the server's Retry-After if it asks for longer than our
          // own backoff (capped); otherwise fall back to exponential backoff.
          let wait = backoffMs(attempt);
          if (resp.status === 429) {
            const ra = retryAfterMs(resp);
            if (ra !== null) wait = Math.min(Math.max(ra, wait), RETRY_AFTER_CAP_MS);
          }
          await resp.body?.cancel().catch(() => {}); // drain so the socket can be reused
          await sleep(wait);
          continue;
        }
      }

      const text = await resp.text();

      if (resp.status >= 200 && resp.status < 300) {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      let body: Json;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      throw new HacknPlanError(resp.status, body, method, path);
    }

    throw new HacknPlanError(0, "exhausted retries", method, path);
  }

  get(path: string, params?: Record<string, unknown>): Promise<Json> {
    return this.request("GET", path, { params });
  }
  post(path: string, body?: Json): Promise<Json> {
    return this.request("POST", path, { body });
  }
  put(path: string, body?: Json): Promise<Json> {
    return this.request("PUT", path, { body });
  }
  patch(path: string, body?: Json): Promise<Json> {
    return this.request("PATCH", path, { body });
  }
  delete(path: string): Promise<Json> {
    return this.request("DELETE", path);
  }

  /**
   * Normalize a list response that may be a bare array OR a paged envelope
   * ({items|results|data: [...]}) into a plain array.
   */
  static asList(resp: Json): Array<Record<string, unknown>> {
    if (resp === null || resp === undefined) return [];
    if (Array.isArray(resp)) return resp as Array<Record<string, unknown>>;
    if (typeof resp === "object") {
      const rec = resp as Record<string, unknown>;
      for (const key of ["items", "results", "data"]) {
        if (Array.isArray(rec[key])) return rec[key] as Array<Record<string, unknown>>;
      }
    }
    return [];
  }
}
