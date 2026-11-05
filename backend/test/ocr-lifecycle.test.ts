import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { InvoiceOcr } from '../src/invoice-ocr';
import type { Principal } from '../src/database';
class Harness extends InvoiceOcr {
  children: ChildProcess[] = [];
  constructor(private modes: string[]) {
    super();
  }
  protected override deadlineMs() {
    return 500;
  }
  protected override spawnWorker() {
    const child = fork(
      resolve(__dirname, 'fixtures/ocr-lifecycle-child.js'),
      [this.modes.shift() ?? 'success'],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
        execArgv: [],
        env: {},
      },
    );
    this.children.push(child);
    return child;
  }
}
const buffer = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const file = { buffer, size: buffer.length, mimetype: 'image/png' };
const code = (expected: string) => (e: unknown) =>
  e instanceof HttpException && (e.getResponse() as { code?: string }).code === expected;
test('un arranque que nunca responde vence y libera el lector para el siguiente documento', async () => {
  const ocr = new Harness(['initialization', 'success']);
  await assert.rejects(ocr.recognize(file), code('OCR_TIMEOUT'));
  assert.equal(ocr.children[0]!.signalCode, 'SIGKILL');
  assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
});
test('un cálculo bloqueado no bloquea el proceso principal y se termina al vencer', async () => {
  const ocr = new Harness(['processing', 'success']);
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 20);
  try {
    await assert.rejects(ocr.recognize(file), code('OCR_TIMEOUT'));
    assert.ok(beats > 2);
    assert.equal(ocr.children[0]!.signalCode, 'SIGKILL');
    assert.equal((await ocr.recognize(file)).attempts, 1);
  } finally {
    clearInterval(heartbeat);
    await ocr.onModuleDestroy();
  }
});
test('fallos y caídas del motor no dejan una ocupación permanente', async () => {
  for (const failure of ['error', 'crash']) {
    const ocr = new Harness([failure, 'success']);
    await assert.rejects(ocr.recognize(file), code('OCR_ENGINE_FAILED'));
    assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
  }
});
test('entrega el resultado sin esperar un cierre interno atascado y recoge el proceso', async () => {
  const ocr = new Harness(['cleanup', 'success']);
  assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
  assert.equal(ocr.children[0]!.signalCode, 'SIGKILL');
  assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
});
test('solo el dueño y el identificador de la lectura pueden cancelarla; una cancelación antigua no afecta otra', async () => {
  const ocr = new Harness(['initialization', 'initialization', 'success']);
  const owner: Principal = { tenantId: randomUUID(), userId: randomUUID(), role: 'admin' },
    id = randomUUID();
  const pending = assert.rejects(
    ocr.recognize(file, undefined, { principal: owner, requestId: id }),
    code('OCR_CANCELLED'),
  );
  await assert.rejects(ocr.recognize(file), code('OCR_BUSY'));
  assert.deepEqual(await ocr.cancel({ ...owner, tenantId: randomUUID() }, id), {
    cancelled: false,
  });
  assert.deepEqual(await ocr.cancel({ ...owner, userId: randomUUID() }, id), { cancelled: false });
  assert.deepEqual(await ocr.cancel(owner, randomUUID()), { cancelled: false });
  assert.deepEqual(await ocr.cancel(owner, id), { cancelled: true });
  await pending;
  const nextId = randomUUID(),
    next = assert.rejects(
      ocr.recognize(file, undefined, { principal: owner, requestId: nextId }),
      code('OCR_CANCELLED'),
    );
  assert.deepEqual(await ocr.cancel(owner, id), { cancelled: false });
  assert.deepEqual(await ocr.cancel(owner, nextId), { cancelled: true });
  await next;
  assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
});
test('desconexión y apagado cancelan también la inicialización y permiten recuperar el servicio', async () => {
  const ocr = new Harness(['initialization', 'initialization', 'success']);
  const controller = new AbortController();
  const aborted = assert.rejects(
    ocr.recognize(file, undefined, { signal: controller.signal }),
    code('OCR_CANCELLED'),
  );
  controller.abort();
  await aborted;
  const shutdown = assert.rejects(ocr.recognize(file), code('OCR_CANCELLED'));
  await ocr.onModuleDestroy();
  await shutdown;
  assert.equal((await ocr.recognize(file)).engine, 'test-fixture');
});
