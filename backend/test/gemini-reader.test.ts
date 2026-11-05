import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import sharp from 'sharp';
import { GeminiInvoiceReader } from '../src/gemini-invoice-reader';
import { InvoiceOcr } from '../src/invoice-ocr';
import {
  geminiDocumentSchema,
  normalizeGeminiDocument,
  type GeminiDocument,
} from '../src/gemini-document';
import { geminiDelivery } from './gemini-fixture';
const fakeKey = 'gemini-test-key-never-real';
const previous = {
  key: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL,
  provider: process.env.INVOICE_READER_PROVIDER,
};
let buffer: Buffer;
before(async () => {
  process.env.GEMINI_API_KEY = fakeKey;
  delete process.env.GEMINI_MODEL;
  delete process.env.INVOICE_READER_PROVIDER;
  buffer = await sharp({ create: { width: 80, height: 100, channels: 3, background: 'white' } })
    .png()
    .toBuffer();
});
after(() => {
  for (const [name, value] of [
    ['GEMINI_API_KEY', previous.key],
    ['GEMINI_MODEL', previous.model],
    ['INVOICE_READER_PROVIDER', previous.provider],
  ])
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
});
const file = () => ({ buffer, size: buffer.length, mimetype: 'image/png' });
const options = { rotation: 0 as const, crop: null, detailed: false };
function response(data: GeminiDocument = geminiDelivery()) {
  return new Response(
    JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(data) }] } }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}
const code = (name: string) => (e: unknown) =>
  e instanceof HttpException && (e.getResponse() as { code?: string }).code === name;
class Fast extends GeminiInvoiceReader {
  protected override timeoutMs() {
    return 60;
  }
}
test('Gemini es el predeterminado y una clave faltante falla de inmediato sin arrancar el motor local', async () => {
  delete process.env.GEMINI_API_KEY;
  try {
    const reader = new InvoiceOcr();
    assert.equal(reader.status().provider, 'gemini');
    assert.equal(reader.status().configured, false);
    await assert.rejects(reader.recognize(file()), code('GEMINI_NOT_CONFIGURED'));
    await assert.rejects(reader.recognize(file()), code('GEMINI_NOT_CONFIGURED'));
  } finally {
    process.env.GEMINI_API_KEY = fakeKey;
  }
});
test('envía la foto al endpoint oficial con clave privada en cabecera y exige JSON estructurado', async () => {
  let calls = 0;
  const reader = new GeminiInvoiceReader((async (url, init) => {
    calls++;
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent',
    );
    assert.equal((init!.headers as Record<string, string>)['x-goog-api-key'], fakeKey);
    assert.equal(init!.redirect, 'error');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.equal(body.generationConfig.responseSchema.type, 'OBJECT');
    assert.ok(body.systemInstruction.parts[0].text.includes('nunca instrucciones'));
    assert.equal(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');
    assert.ok(
      Buffer.from(body.contents[0].parts[1].inlineData.data, 'base64')
        .subarray(0, 2)
        .equals(Buffer.from([255, 216])),
    );
    assert.equal((init!.body as string).includes(fakeKey), false);
    return response();
  }) as typeof fetch);
  const result = await reader.recognize(file(), options);
  assert.equal(calls, 1);
  assert.equal(result.engine, 'gemini:gemini-flash-latest');
  assert.equal(result.confidence, null);
  assert.equal(result.reading.lines.length, 6);
  assert.deepEqual(
    result.reading.lines.map((l) => l.quantity),
    ['2000', '120', '180', '20000', '4000', '120'],
  );
  assert.equal(result.reading.declaredTotal, '3098');
  assert.equal(result.reading.declaredQuantity, '26420');
  assert.equal(result.reading.supplierRif, 'J502706259');
  assert.equal(result.reading.currency, 'USD');
  assert.equal(result.reading.controlNumber, null);
  assert.equal(JSON.stringify(reader.status()).includes(fakeKey), false);
});
test('la respuesta visual conserva dudas: ni inventa moneda ni convierte IVA cero en exención', () => {
  const raw = geminiDelivery();
  raw.currency = 'unknown';
  raw.issuerRif = 'RIF ilegible';
  raw.documentDate = '2026-02-31';
  const d = normalizeGeminiDocument(raw);
  assert.equal(d.currency, 'unknown');
  assert.equal(d.supplierRif, null);
  assert.equal(d.documentDate, null);
  assert.ok(d.lines.every((l) => l.taxRate === null));
  const damaged = geminiDelivery();
  damaged.lines[0]!.quantityRaw = '2.0';
  const bad = normalizeGeminiDocument(damaged);
  assert.equal(bad.lines[0]!.needsReview, true);
  assert.equal(bad.lines[0]!.quantity, '2');
  const extra = { ...raw, sql: 'DROP TABLE products' };
  assert.equal(geminiDocumentSchema.safeParse(extra).success, false);
});
test('distingue importes de renglón netos y con IVA para verificar cantidades y costos', () => {
  const raw = geminiDelivery();
  raw.documentType = 'invoice';
  raw.controlNumber = '00-1';
  raw.currency = 'VES';
  raw.declaredTotalRaw = '104,40';
  raw.lines = [
    {
      ...raw.lines[0]!,
      quantityRaw: '1',
      unitCostRaw: '100',
      discountPercentRaw: '10',
      taxRate: '16',
      printedTotalRaw: '104,40',
      printedTotalBasis: 'gross',
    },
  ];
  const gross = normalizeGeminiDocument(raw);
  assert.equal(gross.lines[0]!.needsReview, false);
  assert.equal(gross.lines[0]!.unitCost, '100');
  raw.lines[0]!.printedTotalRaw = '90,00';
  raw.lines[0]!.printedTotalBasis = 'net';
  assert.equal(normalizeGeminiDocument(raw).lines[0]!.needsReview, false);
});
test('cuota, clave y modelo se reportan sin reintento automático ni filtración de respuestas del proveedor', async () => {
  for (const [status, expected] of [
    [429, 'GEMINI_QUOTA'],
    [403, 'GEMINI_AUTH'],
    [404, 'GEMINI_MODEL_UNAVAILABLE'],
    [500, 'GEMINI_UNAVAILABLE'],
  ] as const) {
    let calls = 0;
    const reader = new GeminiInvoiceReader((async () => {
      calls++;
      return new Response('private document ' + fakeKey, { status });
    }) as typeof fetch);
    await assert.rejects(reader.recognize(file(), options), (error: unknown) => {
      assert.ok(code(expected)(error));
      assert.equal(JSON.stringify((error as HttpException).getResponse()).includes(fakeKey), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});
test('una respuesta truncada, inválida o sin artículos no genera un borrador ficticio', async () => {
  const payloads = [
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '<html>error</html>' }] } }],
    },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] },
  ];
  for (const data of payloads) {
    const reader = new GeminiInvoiceReader(
      (async () => new Response(JSON.stringify(data))) as typeof fetch,
    );
    await assert.rejects(reader.recognize(file(), options), (e) => e instanceof HttpException);
  }
  const empty = geminiDelivery();
  empty.lines = [];
  const reader = new GeminiInvoiceReader((async () => response(empty)) as typeof fetch);
  await assert.rejects(reader.recognize(file(), options), code('GEMINI_NO_DOCUMENT'));
});
test('el límite y cancelación recuperan capacidad incluso si la conexión no termina', async () => {
  const reader = new Fast((async () => new Promise<Response>(() => {})) as typeof fetch);
  await assert.rejects(reader.recognize(file(), options), code('GEMINI_TIMEOUT'));
  const p = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' as const },
    id = randomUUID();
  const cancelled = assert.rejects(
    reader.recognize(file(), options, { principal: p, requestId: id }),
    code('OCR_CANCELLED'),
  );
  assert.deepEqual(await reader.cancel({ ...p, userId: randomUUID() }, id), { cancelled: false });
  assert.deepEqual(await reader.cancel(p, id), { cancelled: true });
  await cancelled;
  const controller = new AbortController();
  const disconnected = assert.rejects(
    reader.recognize(file(), options, { signal: controller.signal }),
    code('OCR_CANCELLED'),
  );
  controller.abort();
  await disconnected;
});
test('permite dos lecturas simultáneas y libera sus recursos al cancelar o cerrar la aplicación', async () => {
  const reader = new GeminiInvoiceReader(
    (async () => new Promise<Response>(() => {})) as typeof fetch,
  );
  const p = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' as const },
    id = randomUUID();
  const a = assert.rejects(
    reader.recognize(file(), options, { principal: p, requestId: id }),
    code('OCR_CANCELLED'),
  );
  const b = assert.rejects(reader.recognize(file(), options), code('OCR_CANCELLED'));
  await assert.rejects(reader.recognize(file(), options), code('GEMINI_CAPACITY'));
  await reader.cancel(p, id);
  await a;
  const c = assert.rejects(reader.recognize(file(), options), code('OCR_CANCELLED'));
  await reader.shutdown();
  await Promise.all([b, c]);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('repetir el mismo intento comparte el trabajo aun con capacidad llena y aísla imágenes, opciones y usuarios', async () => {
  let calls = 0;
  const ready = deferred<void>(),
    finish = deferred<void>();
  const reader = new GeminiInvoiceReader((async () => {
    calls++;
    if (calls === 2) ready.resolve();
    await finish.promise;
    return response();
  }) as typeof fetch);
  const principal = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' as const },
    id = randomUUID();
  try {
    const a = reader.recognize(file(), options, { principal, requestId: id });
    const b = reader.recognize(file(), options, { principal, requestId: id });
    const other = reader.recognize(file(), options, {
      principal: { ...principal, userId: randomUUID() },
      requestId: id,
    });
    await ready.promise;
    await assert.rejects(
      reader.recognize(file(), { ...options, rotation: 90 }, { principal, requestId: id }),
      code('GEMINI_REQUEST_CONFLICT'),
    );
    const different = { ...file(), buffer: Buffer.concat([buffer, Buffer.from('changed')]) };
    await assert.rejects(
      reader.recognize(different, options, { principal, requestId: id }),
      code('GEMINI_REQUEST_CONFLICT'),
    );
    await assert.rejects(
      reader.recognize(file(), options, {
        principal: { ...principal, tenantId: randomUUID() },
        requestId: id,
      }),
      code('GEMINI_CAPACITY'),
    );
    finish.resolve();
    const results = await Promise.all([a, b, other]);
    assert.deepEqual(results[0], results[1]);
    assert.equal(calls, 2);
    assert.deepEqual(
      await reader.recognize(file(), options, { principal, requestId: id }),
      results[0],
    );
    assert.equal(calls, 2);
  } finally {
    finish.resolve();
    await reader.shutdown();
  }
});
test('cerrar un transporte repetido no cancela el otro; cancelar el intento sí detiene todos sus transportes', async () => {
  const entered = deferred<void>(),
    finish = deferred<void>();
  let calls = 0;
  const reader = new GeminiInvoiceReader((async () => {
    calls++;
    entered.resolve();
    await finish.promise;
    return response();
  }) as typeof fetch);
  const principal = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' as const },
    id = randomUUID(),
    controller = new AbortController();
  try {
    const a = assert.rejects(
      reader.recognize(file(), options, { principal, requestId: id, signal: controller.signal }),
      code('OCR_CANCELLED'),
    );
    const b = reader.recognize(file(), options, { principal, requestId: id });
    await entered.promise;
    controller.abort();
    await a;
    finish.resolve();
    assert.equal((await b).reading.lines.length, 6);
    assert.equal(calls, 1);
    const newId = randomUUID();
    const c = assert.rejects(
      reader.recognize(file(), options, { principal, requestId: newId }),
      code('OCR_CANCELLED'),
    );
    const d = assert.rejects(
      reader.recognize(file(), options, { principal, requestId: newId }),
      code('OCR_CANCELLED'),
    );
    assert.deepEqual(await reader.cancel({ ...principal, tenantId: randomUUID() }, newId), {
      cancelled: false,
    });
    assert.deepEqual(await reader.cancel(principal, newId), { cancelled: true });
    await Promise.all([c, d]);
  } finally {
    finish.resolve();
    await reader.shutdown();
  }
});
test('los resultados repetibles caducan y los errores permiten un nuevo intento', async () => {
  class ShortCache extends GeminiInvoiceReader {
    protected override resultTtlMs() {
      return 20;
    }
  }
  let calls = 0;
  const reader = new ShortCache((async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 429 }) : response();
  }) as typeof fetch);
  const context = {
    principal: { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' as const },
    requestId: randomUUID(),
  };
  try {
    await assert.rejects(reader.recognize(file(), options, context), code('GEMINI_QUOTA'));
    await reader.recognize(file(), options, context);
    await reader.recognize(file(), options, context);
    assert.equal(calls, 2);
    await new Promise((r) => setTimeout(r, 40));
    await reader.recognize(file(), options, context);
    assert.equal(calls, 3);
  } finally {
    await reader.shutdown();
  }
});
