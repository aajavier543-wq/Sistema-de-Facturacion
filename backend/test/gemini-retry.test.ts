import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGeminiWithRetry, googleRetryDelay } from '../src/gemini-retry';
const url = 'https://generativelanguage.googleapis.com/v1beta/models/test:generateContent';
test('503 y 502 explícitos se recuperan reutilizando exactamente modelo, cuerpo y señal', async () => {
  let calls = 0;
  const controller = new AbortController();
  const init = { method: 'POST', body: 'same-image-payload', signal: controller.signal };
  const result = await fetchGeminiWithRetry(
    (async (target, request) => {
      calls++;
      assert.equal(target, url);
      assert.equal(request, init);
      return new Response(calls < 3 ? 'busy' : 'ok', { status: [503, 502, 200][calls - 1] });
    }) as typeof fetch,
    url,
    init,
    Date.now() + 1000,
    1,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});
test('un fallo persistente termina al tercer intento; errores de clave/cuota y resultados inciertos no se reintentan', async () => {
  for (const status of [400, 401, 403, 404, 429, 500, 502, 503, 504]) {
    let calls = 0;
    const result = await fetchGeminiWithRetry(
      (async () => {
        calls++;
        return new Response('provider-error', { status });
      }) as typeof fetch,
      url,
      {},
      Date.now() + 1000,
      1,
    );
    assert.equal(calls, status >= 500 ? 3 : 1);
    assert.equal(result.attempts, calls);
    assert.equal(result.response.status, status);
    assert.equal(await result.response.text(), 'provider-error');
  }
  let calls = 0;
  await assert.rejects(
    fetchGeminiWithRetry(
      (async () => {
        calls++;
        throw new Error('network failure');
      }) as typeof fetch,
      url,
      {},
      Date.now() + 1000,
      1,
    ),
  );
  assert.equal(calls, 1);
});
test('Retry-After se respeta y una espera que no cabe en el plazo no provoca otra solicitud', async () => {
  const now = Date.now();
  assert.equal(
    googleRetryDelay(new Response('', { headers: { 'retry-after': '120' } }), 1, 1000, now),
    120000,
  );
  const future = new Date(Math.ceil(now / 1000) * 1000 + 3000).toUTCString();
  assert.equal(
    googleRetryDelay(new Response('', { headers: { 'retry-after': future } }), 1, 1000, now),
    Date.parse(future) - now,
  );
  let calls = 0;
  const result = await fetchGeminiWithRetry(
    (async () => {
      calls++;
      return new Response('busy', { status: 503, headers: { 'retry-after': '120' } });
    }) as typeof fetch,
    url,
    {},
    now + 20000,
    1,
  );
  assert.equal(calls, 1);
  assert.equal(result.response.status, 503);
});
test('cancelar durante la espera impide el próximo intento y un contexto ya cancelado nunca consulta al proveedor', async () => {
  const controller = new AbortController();
  let calls = 0;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = fetchGeminiWithRetry(
    (async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            started();
          },
        }),
        { status: 503 },
      );
    }) as typeof fetch,
    url,
    { signal: controller.signal },
    Date.now() + 1000,
    20,
  );
  const cancelled = assert.rejects(pending, (e: Error) => e.name === 'AbortError');
  await waiting;
  controller.abort();
  await cancelled;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  await assert.rejects(
    fetchGeminiWithRetry(
      (async () => {
        calls++;
        return new Response();
      }) as typeof fetch,
      url,
      { signal: controller.signal },
      Date.now() + 1000,
      1,
    ),
    (e: Error) => e.name === 'AbortError',
  );
  assert.equal(calls, 1);
});
