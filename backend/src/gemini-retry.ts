const temporaryStatuses = new Set([500, 502, 503, 504]);
const aborted = () => new DOMException('Request aborted', 'AbortError');
export function googleRetryDelay(
  response: Response,
  attempt: number,
  baseMs: number,
  now = Date.now(),
) {
  const header = response.headers.get('retry-after');
  if (header) {
    if (/^\d+(?:\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  return baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * (baseMs / 4));
}
function pause(ms: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
function discard(response: Response) {
  // A body that cannot be drained must not hold up cancellation or the next attempt.
  void response.body?.cancel().catch(() => {});
}
export async function fetchGeminiWithRetry(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  deadlineAt: number,
  baseMs = 1000,
): Promise<{ response: Response; attempts: number }> {
  for (let attempts = 1; ; attempts++) {
    if (init.signal?.aborted) throw aborted();
    // Network failures/unknown outcomes are deliberately not retried, especially POSTs.
    const response = await fetcher(url, init);
    if (init.signal?.aborted) {
      discard(response);
      throw aborted();
    }
    if (!temporaryStatuses.has(response.status) || attempts >= 3) return { response, attempts };
    const wait = googleRetryDelay(response, attempts, baseMs);
    // Preserve the original operation's deadline and never retry earlier than Retry-After.
    if (!Number.isFinite(wait) || wait >= deadlineAt - Date.now()) return { response, attempts };
    discard(response);
    await pause(wait, init.signal);
  }
}
