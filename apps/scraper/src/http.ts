/**
 * Tiny fetch wrapper. We deliberately do not pull in `got` / `undici`'s
 * Dispatcher — Node 22's built-in `fetch` covers everything we need, and an
 * extra dep here would be the start of a long tail.
 *
 * Retries: only retried on 5xx and on the network errors that fetch surfaces
 * as a thrown `TypeError`. 4xx is the caller's problem (a 404 on hacs.json,
 * for instance, is meaningful — not a failure).
 */

const DEFAULT_UA = 'hacs-stats/0.0.0 (+https://hacs-stats.dev)';

export interface FetchTextOptions {
  // `| undefined` on every field because `exactOptionalPropertyTypes` is on:
  // without it, callers can't pass `process.env.GITHUB_TOKEN` (string|undefined)
  // through without first narrowing.
  /** GitHub PAT for the api.github.com host. Optional. */
  bearerToken?: string | undefined;
  /** Override the default UA — tests use this to assert. */
  userAgent?: string | undefined;
  /** Total retry attempts on 5xx / network errors. Default 2 (i.e. 3 total tries). */
  retries?: number | undefined;
  /** Delay between retries, in ms. Default 1000. */
  retryDelayMs?: number | undefined;
  /** Inject a fetch impl for tests. */
  fetchImpl?: typeof fetch | undefined;
  /** Inject a sleep impl for tests. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  const retries = opts.retries ?? 2;
  const retryDelay = opts.retryDelayMs ?? 1000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  const headers: Record<string, string> = { 'User-Agent': opts.userAgent ?? DEFAULT_UA };
  if (opts.bearerToken) headers.Authorization = `Bearer ${opts.bearerToken}`;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(url, { headers });
      if (res.status >= 500 && attempt < retries) {
        lastErr = new HttpError(url, res.status, await res.text());
        await sleep(retryDelay);
        continue;
      }
      if (!res.ok) {
        // 4xx: throw immediately, the caller distinguishes 404 from other failures.
        throw new HttpError(url, res.status, await res.text());
      }
      return await res.text();
    } catch (err) {
      // fetch() throws TypeError on network failures (DNS, refused, reset).
      // Treat those as transient.
      if (err instanceof HttpError && err.status < 500) throw err;
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('fetchText: exhausted retries');
}

export async function fetchJson<T>(url: string, opts: FetchTextOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  return JSON.parse(text) as T;
}
