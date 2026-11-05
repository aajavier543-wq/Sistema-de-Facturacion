import { test } from 'node:test';
import assert from 'node:assert/strict';
import { googleFailure } from '../src/gemini-errors';
const secret = 'fake-private-key-never-real';
const detail = (reason: string) => ({
  '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
  reason,
  metadata: { consumer: 'private-project', key: secret },
});
test('clasifica rechazos 400/403 de Google por motivo sin revelar mensajes, claves ni metadatos', async () => {
  for (const [status, reason, code] of [
    [400, 'API_KEY_INVALID', 'GEMINI_INVALID_KEY'],
    [400, 'API_KEY_EXPIRED', 'GEMINI_INVALID_KEY'],
    [403, 'API_KEY_LEAKED', 'GEMINI_KEY_EXPOSED'],
    [403, 'API_KEY_HTTP_REFERRER_BLOCKED', 'GEMINI_KEY_RESTRICTED'],
    [403, 'API_KEY_SERVICE_BLOCKED', 'GEMINI_KEY_RESTRICTED'],
    [403, 'SERVICE_DISABLED', 'GEMINI_API_DISABLED'],
    [400, 'BILLING_DISABLED', 'GEMINI_PROJECT_UNAVAILABLE'],
  ] as const) {
    const error = await googleFailure(
      Response.json({ error: { message: secret, details: [detail(reason)] } }, { status }),
    );
    const body = error.getResponse() as any;
    assert.equal(body.code, code);
    assert.equal(body.providerStatus, status);
    assert.match(body.message, new RegExp('HTTP ' + status));
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(JSON.stringify(body).includes('private-project'), false);
  }
});
test('distingue clave expuesta, región, cupo gratuito y formato del cuerpo con mensajes estáticos', async () => {
  for (const [message, code] of [
    ['Your API key was reported as leaked. Please use another API key.', 'GEMINI_KEY_EXPOSED'],
    ['API key not valid. Please pass a valid API key.', 'GEMINI_INVALID_KEY'],
    ['User location is not supported for API use.', 'GEMINI_REGION_UNAVAILABLE'],
    ['Free tier is not available in your country.', 'GEMINI_FREE_TIER_UNAVAILABLE'],
    ['Invalid JSON payload received. Unknown name responseSchema.', 'GEMINI_REQUEST_FORMAT'],
    ['This model is not supported for generateContent', 'GEMINI_MODEL_UNAVAILABLE'],
    ['Other unknown rejection ' + secret, 'GEMINI_BAD_REQUEST'],
  ]) {
    const error = await googleFailure(Response.json({ error: { message } }, { status: 400 }));
    const body = error.getResponse() as any;
    assert.equal(body.code, code);
    assert.equal(JSON.stringify(body).includes(secret), false);
  }
});
test('respuestas inválidas o sobredimensionadas no filtran datos ni rompen el diagnóstico HTTP', async () => {
  for (const content of [
    '<html>' + secret,
    JSON.stringify({ error: { message: secret.repeat(10000) } }),
    'null',
    '{"error":{"details":{}}}',
  ]) {
    const error = await googleFailure(new Response(content, { status: 400 }));
    const body = error.getResponse() as any;
    assert.equal(body.code, 'GEMINI_BAD_REQUEST');
    assert.equal(JSON.stringify(body).includes(secret), false);
  }
  for (const [status, code] of [
    [401, 'GEMINI_AUTH'],
    [429, 'GEMINI_QUOTA'],
    [404, 'GEMINI_MODEL_UNAVAILABLE'],
    [413, 'GEMINI_IMAGE_TOO_LARGE'],
    [500, 'GEMINI_UNAVAILABLE'],
    [503, 'GEMINI_SERVICE_BUSY'],
  ] as const) {
    const error = await googleFailure(new Response(secret, { status }));
    assert.equal((error.getResponse() as any).code, code);
    assert.equal(JSON.stringify(error.getResponse()).includes(secret), false);
  }
});
