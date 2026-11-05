import 'reflect-metadata';
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ExecutionContext, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import sharp from 'sharp';
import { InvoiceImageController } from '../src/invoice-controller';
import { InvoiceOcr } from '../src/invoice-ocr';
import { Database } from '../src/database';
import { InvoiceImporter } from '../src/invoice-import';
import { TenantGuard } from '../src/auth';
import { geminiDelivery } from './gemini-fixture';

test('HTTP multipart Gemini: envío, repetición concurrente y reenvío de respuesta perdida consultan una vez por intento', async () => {
  const nativeFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousProvider = process.env.INVOICE_READER_PROVIDER;
  process.env.GEMINI_API_KEY = 'fake-http-key-never-real';
  process.env.INVOICE_READER_PROVIDER = 'gemini';
  let calls = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method === 'GET')
      return Response.json({ supportedGenerationMethods: ['generateContent'] });
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: 'STOP',
            content: { parts: [{ text: JSON.stringify(geminiDelivery()) }] },
          },
        ],
      }),
    );
  }) as typeof fetch;
  const reader = new InvoiceOcr();
  globalThis.fetch = nativeFetch;
  const principal = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' };
  const guard = mock.method(TenantGuard.prototype, 'canActivate', (context: ExecutionContext) => {
    context.switchToHttp().getRequest().principal = principal;
    return true;
  });
  @Module({
    controllers: [InvoiceImageController],
    providers: [
      { provide: InvoiceOcr, useValue: reader },
      { provide: Database, useValue: {} },
      { provide: InvoiceImporter, useValue: {} },
      TenantGuard,
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const buffer = await sharp({
      create: { width: 40, height: 50, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const url = (await app.getUrl()) + '/goods/invoice-images/read';
    const send = (id: string, rotation = 0) => {
      const form = new FormData();
      form.append(
        'image',
        new Blob([new Uint8Array(buffer)], { type: 'image/png' }),
        'factura.png',
      );
      form.append('options', JSON.stringify({ rotation, detailed: false, crop: null }));
      form.append('requestId', id);
      return nativeFetch(url, { method: 'POST', body: form });
    };
    const check = await nativeFetch((await app.getUrl()) + '/goods/invoice-images/check', {
      method: 'POST',
    });
    assert.equal(check.status, 200);
    assert.equal(((await check.json()) as any).available, true);
    assert.equal(calls, 0, 'la comprobación no debe generar contenido');
    const result = await send(randomUUID());
    const body = (await result.json()) as any;
    assert.equal(result.status, 201, JSON.stringify(body));
    assert.equal(body.reading.lines.length, 6);
    assert.equal(calls, 1);
    const id = randomUUID();
    const repeated = await Promise.all([send(id), send(id)]);
    const bodies = await Promise.all(
      repeated.map(async (r) => {
        const body = await r.json();
        assert.equal(r.status, 201, JSON.stringify(body));
        return body;
      }),
    );
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(calls, 2, 'el reenvío concurrente no debe consultar Gemini de nuevo');
    const replay = await send(id);
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), bodies[0]);
    assert.equal(calls, 2, 'repetir tras perder la respuesta HTTP reutiliza el resultado');
    const conflict = await send(id, 90);
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as any).code, 'GEMINI_REQUEST_CONFLICT');
    assert.equal(calls, 2);
  } finally {
    await app.close();
    guard.mock.restore();
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousProvider === undefined) delete process.env.INVOICE_READER_PROVIDER;
    else process.env.INVOICE_READER_PROVIDER = previousProvider;
  }
});
