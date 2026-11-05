import { BadRequestException, HttpException, Injectable, OnModuleDestroy } from '@nestjs/common';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Principal } from './database';
import type { InvoiceReading } from './invoice-parser';
import type { OcrOptions } from './ocr-options';
import { GeminiInvoiceReader } from './gemini-invoice-reader';
export { ocrOptionsSchema, type OcrOptions } from './ocr-options';
export type OcrResult = {
  reading: InvoiceReading;
  rawText: string;
  confidence: number | null;
  imageHash: string;
  attempts: number;
  engine: string;
};
type Context = { principal?: Principal; requestId?: string; signal?: AbortSignal };
type Outcome = { result: OcrResult } | { error: HttpException };
type ActiveTask = {
  id: string;
  principal?: Principal;
  stop: (error: HttpException) => void;
  done: Promise<void>;
};
const cancelled = () =>
  new HttpException(
    { code: 'OCR_CANCELLED', message: 'Lectura cancelada. Puedes volver a intentarlo.' },
    409,
  );
const failed = () =>
  new HttpException(
    {
      code: 'OCR_ENGINE_FAILED',
      message:
        'El motor de lectura no pudo completar la imagen y se reinició. Puedes volver a intentarlo o usar una foto recortada.',
    },
    503,
  );

@Injectable()
export class InvoiceOcr implements OnModuleDestroy {
  private active: ActiveTask | null = null;
  private readonly gemini = new GeminiInvoiceReader();
  protected readerMode() {
    return process.env.INVOICE_READER_PROVIDER ?? 'gemini';
  }
  status() {
    if (this.readerMode() === 'local')
      return {
        provider: 'local',
        displayName: 'Lector local',
        configured: true,
        external: false,
        waitSeconds: 60,
      };
    if (this.readerMode() === 'gemini') return this.gemini.status();
    return {
      provider: 'invalid',
      displayName: 'Lector sin configurar',
      configured: false,
      external: false,
      waitSeconds: 60,
    };
  }
  protected deadlineMs(detailed: boolean): number {
    return detailed ? 90_000 : 60_000;
  }
  protected spawnWorker(): ChildProcess {
    // This process needs local files only, never database, bootstrap or Render credentials.
    const env: NodeJS.ProcessEnv = {};
    for (const name of ['NODE_ENV', 'PATH', 'TMPDIR', 'LANG', 'TZ'])
      if (process.env[name]) env[name] = process.env[name];
    return fork(resolve(__dirname, '../scripts/invoice-ocr-child.js'), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
      execArgv: [],
      env,
    });
  }
  async recognize(
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    options: OcrOptions = { rotation: 0, detailed: false, crop: null },
    context: Context = {},
  ): Promise<OcrResult> {
    if (!file || !Buffer.isBuffer(file.buffer))
      throw new BadRequestException('Selecciona una imagen del documento');
    const b = file.buffer;
    if (file.size > 8 * 1024 * 1024 || b.length > 8 * 1024 * 1024)
      throw new BadRequestException('La imagen no puede superar 8 MB');
    const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
      png = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      webp =
        b.length > 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp)
      throw new BadRequestException('Solo se admiten imágenes JPEG, PNG o WebP reales');
    if (this.readerMode() === 'gemini') return this.gemini.recognize(file, options, context);
    if (this.readerMode() !== 'local')
      throw new HttpException(
        {
          code: 'READER_NOT_CONFIGURED',
          message: 'Selecciona un proveedor válido en INVOICE_READER_PROVIDER.',
        },
        503,
      );
    if (context.signal?.aborted) throw cancelled();
    if (this.active)
      throw new HttpException(
        {
          code: 'OCR_BUSY',
          retryAfterSeconds: 2,
          message:
            'El lector está ocupado con otra imagen. La lectura tiene un tiempo límite; vuelve a intentarlo en unos segundos.',
        },
        429,
      );
    let complete!: () => void;
    const done = new Promise<void>((r) => {
      complete = r;
    });
    const task: ActiveTask = {
      id: context.requestId ?? randomUUID(),
      principal: context.principal,
      stop: () => {},
      done,
    };
    this.active = task;
    return new Promise<OcrResult>((resolveResult, rejectResult) => {
      let child: ChildProcess | undefined,
        outcome: Outcome | undefined,
        settled = false;
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (cleanupTimer) clearTimeout(cleanupTimer);
        context.signal?.removeEventListener('abort', onAbort);
        if (this.active === task) this.active = null;
        complete();
        if (outcome && 'result' in outcome) resolveResult(outcome.result);
        else rejectResult(outcome && 'error' in outcome ? outcome.error : failed());
      };
      const stop = (error?: HttpException) => {
        if (settled) return;
        // Cancellation can override a result that has not yet been delivered/reaped.
        if (error) outcome = { error };
        try {
          if (child?.pid && child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
        } catch {}
        if (!child?.pid) {
          finish();
          return;
        }
        // Bounded cleanup protects against a missing child event after termination.
        cleanupTimer ??= setTimeout(finish, 1000);
      };
      task.stop = (error) => stop(error);
      const onAbort = () => stop(cancelled());
      const deadline = setTimeout(
        () =>
          stop(
            new HttpException(
              {
                code: 'OCR_TIMEOUT',
                message:
                  'La lectura superó el tiempo límite y se canceló. El lector está disponible para volver a intentarlo; prueba recortando la foto.',
              },
              504,
            ),
          ),
        this.deadlineMs(options.detailed),
      );
      context.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        child = this.spawnWorker();
        child.once('error', () => {
          outcome = { error: failed() };
          stop();
        });
        child.once('exit', () => finish());
        child.once('close', () => finish());
        child.on('message', (message: { type?: string; result?: OcrResult; code?: string }) => {
          if (outcome || settled) return;
          outcome =
            message.type === 'result' && message.result
              ? { result: message.result }
              : {
                  error:
                    message.code === 'OCR_INVALID_IMAGE'
                      ? new BadRequestException({
                          code: 'OCR_INVALID_IMAGE',
                          message:
                            'La imagen debe ser una sola página de hasta 12 megapíxeles. Revisa el archivo o usa una foto más pequeña.',
                        })
                      : failed(),
                };
          stop();
        });
        if (context.signal?.aborted) {
          onAbort();
          return;
        }
        child.send({ type: 'read', buffer: b, options }, (error) => {
          if (error && !settled) {
            outcome = { error: failed() };
            stop();
          }
        });
      } catch {
        outcome = { error: failed() };
        stop();
      }
    });
  }
  async cancel(principal: Principal, requestId: string) {
    const external = await this.gemini.cancel(principal, requestId);
    if (external.cancelled) return external;
    const task = this.active;
    if (
      !task ||
      task.id !== requestId ||
      task.principal?.tenantId !== principal.tenantId ||
      task.principal?.userId !== principal.userId
    )
      return { cancelled: false };
    task.stop(cancelled());
    await task.done;
    return { cancelled: true };
  }
  async onModuleDestroy() {
    await this.gemini.shutdown();
    const task = this.active;
    if (task) {
      task.stop(cancelled());
      await task.done;
    }
  }
}
