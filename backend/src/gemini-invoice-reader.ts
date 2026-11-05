import { BadRequestException, HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Principal } from './database';
import type { OcrOptions } from './ocr-options';
import type { OcrResult } from './invoice-ocr';
import { boundedGoogleJson, googleFailure } from './gemini-errors';
import { fetchGeminiWithRetry } from './gemini-retry';
import {
  documentVisionInstruction,
  geminiDocumentSchema,
  geminiResponseSchema,
  normalizeGeminiDocument,
} from './gemini-document';
type Context = { principal?: Principal; requestId?: string; signal?: AbortSignal };
type Task = {
  fingerprint: string;
  stop: (error: HttpException) => void;
  done: Promise<void>;
  result: Promise<OcrResult>;
  waiters: number;
  settled: boolean;
};
type Completed = { fingerprint: string; result: OcrResult; timer: ReturnType<typeof setTimeout> };
const failure = (code: string, message: string, status = 503) =>
  new HttpException({ code, message }, status);
const cancelled = () =>
  failure('OCR_CANCELLED', 'Lectura cancelada. Puedes volver a intentarlo.', 409);
const timeout = () =>
  failure(
    'GEMINI_TIMEOUT',
    'Gemini tardó demasiado y se canceló la lectura. Puedes volver a intentarlo o recortar la imagen.',
    504,
  );
export class GeminiInvoiceReader {
  private tasks = new Map<string, Task>();
  private completed = new Map<string, Completed>();
  private taskKey(principal: Principal | undefined, id: string) {
    return JSON.stringify([principal?.tenantId ?? null, principal?.userId ?? null, id]);
  }
  protected resultTtlMs() {
    return 60_000;
  }
  private remember(id: string, fingerprint: string, result: OcrResult) {
    // Bounded short-lived replay after an HTTP response is lost. Never retain the image.
    while (this.completed.size >= 16) {
      const oldest = this.completed.keys().next().value!;
      clearTimeout(this.completed.get(oldest)!.timer);
      this.completed.delete(oldest);
    }
    const entry: Completed = {
      fingerprint,
      result,
      timer: setTimeout(() => {
        if (this.completed.get(id) === entry) this.completed.delete(id);
      }, this.resultTtlMs()),
    };
    entry.timer.unref();
    this.completed.set(id, entry);
  }
  private async waitFor(task: Task, signal?: AbortSignal) {
    task.waiters++;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled());
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      return await Promise.race([task.result, aborted]);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      task.waiters--;
      // A transport retry may still be awaiting the same job after one socket closes.
      if (task.waiters === 0 && !task.settled) task.stop(cancelled());
    }
  }
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  protected timeoutMs() {
    return 90_000;
  }
  private config() {
    const key = process.env.GEMINI_API_KEY?.trim() ?? '',
      model = process.env.GEMINI_MODEL?.trim() || 'gemini-flash-latest';
    return { key, model, validModel: /^gemini-[a-z0-9.-]+$/.test(model) };
  }
  status() {
    const c = this.config();
    return {
      provider: 'gemini' as const,
      displayName: 'Gemini con visión',
      configured: !!c.key && c.validModel,
      model: c.model,
      external: true,
      waitSeconds: Math.ceil(this.timeoutMs() / 1000),
    };
  }
  protected retryBaseMs() {
    return 1000;
  }
  protected checkTimeoutMs() {
    return 15_000;
  }
  async checkConnection(signal?: AbortSignal) {
    const { key, model, validModel } = this.config();
    if (!key)
      throw failure(
        'GEMINI_NOT_CONFIGURED',
        'Falta configurar GEMINI_API_KEY en Render. Guarda los cambios de entorno y despliega.',
      );
    if (!validModel)
      throw failure('GEMINI_MODEL_INVALID', 'La configuración de GEMINI_MODEL no es válida.');
    if (signal?.aborted) throw cancelled();
    const controller = new AbortController();
    let rejectStopped!: (reason: HttpException) => void;
    let reason: HttpException | undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const stop = (error: HttpException) => {
      if (reason) return;
      reason = error;
      controller.abort();
      rejectStopped(error);
    };
    const onAbort = () => stop(cancelled());
    const deadlineAt = Date.now() + this.checkTimeoutMs();
    const timer = setTimeout(
      () =>
        stop(
          failure(
            'GEMINI_CHECK_TIMEOUT',
            'La comprobación con Google superó el tiempo límite. Revisa la conexión del servidor e inténtalo de nuevo.',
            504,
          ),
        ),
      this.checkTimeoutMs(),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    const check = async () => {
      try {
        if (signal?.aborted) onAbort();
        if (reason) throw reason;
        const { response, attempts } = await fetchGeminiWithRetry(
          this.fetcher,
          'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model),
          {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { 'x-goog-api-key': key, accept: 'application/json' },
          },
          deadlineAt,
          this.retryBaseMs(),
        );
        if (reason) throw reason;
        if (!response.ok) throw await googleFailure(response, attempts);
        const data = (await boundedGoogleJson(response)) as any;
        if (reason) throw reason;
        if (
          !Array.isArray(data?.supportedGenerationMethods) ||
          !data.supportedGenerationMethods.includes('generateContent')
        )
          throw failure(
            'GEMINI_MODEL_UNAVAILABLE',
            'Google respondió, pero el modelo no admite generateContent. Revisa GEMINI_MODEL.',
          );
        return {
          provider: 'gemini',
          model,
          available: true,
          attempts,
          checkedAt: new Date().toISOString(),
          message:
            'Google aceptó la clave y confirmó el acceso al modelo. La lectura de imágenes y su cuota se comprobarán al importar.',
        };
      } catch (error) {
        if (reason) throw reason;
        if (error instanceof HttpException) throw error;
        throw failure(
          'GEMINI_NETWORK',
          'El servidor no pudo conectarse con Google. Revisa la conexión y vuelve a comprobar.',
        );
      }
    };
    try {
      return await Promise.race([check(), stopped]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async recognize(
    file: { buffer: Buffer; mimetype: string; size: number },
    options: OcrOptions,
    context: Context = {},
  ): Promise<OcrResult> {
    const { key, model, validModel } = this.config();
    if (!key)
      throw failure(
        'GEMINI_NOT_CONFIGURED',
        'Gemini aún no está conectado. El administrador debe configurar GEMINI_API_KEY en el servidor.',
      );
    if (!validModel)
      throw failure('GEMINI_MODEL_INVALID', 'La configuración del modelo Gemini no es válida.');
    if (context.signal?.aborted) throw cancelled();
    const id = this.taskKey(context.principal, context.requestId ?? randomUUID());
    const imageHash = createHash('sha256').update(file.buffer).digest('hex');
    const fingerprint = createHash('sha256')
      .update(imageHash)
      .update(
        JSON.stringify({
          rotation: options.rotation,
          crop: options.crop,
          detailed: options.detailed,
        }),
      )
      .digest('hex');
    const existing = this.tasks.get(id) ?? this.completed.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw failure(
          'GEMINI_REQUEST_CONFLICT',
          'Este intento corresponde a otra imagen u opciones. Inicia una lectura nueva.',
          409,
        );
      return 'waiters' in existing ? this.waitFor(existing, context.signal) : existing.result;
    }
    if (this.tasks.size >= 2)
      throw failure(
        'GEMINI_CAPACITY',
        'Hay dos lecturas de Gemini en curso. Espera unos segundos o cancela tu lectura anterior.',
        429,
      );
    const controller = new AbortController();
    let rejectStopped!: (reason: HttpException) => void,
      complete!: () => void,
      reason: HttpException | undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectStopped = reject;
    });
    const done = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const task: Task = {
      fingerprint,
      done,
      result: undefined!,
      waiters: 0,
      settled: false,
      stop: (error) => {
        if (reason) return;
        reason = error;
        controller.abort();
        rejectStopped(error);
      },
    };
    this.tasks.set(id, task);
    const deadlineAt = Date.now() + this.timeoutMs();
    const deadline = setTimeout(() => task.stop(timeout()), this.timeoutMs());
    const active = () => {
      if (reason) throw reason;
    };
    const operation = async (): Promise<OcrResult> => {
      try {
        active();
        const source = sharp(file.buffer, { limitInputPixels: 12000000, animated: false });
        const m = await source.metadata();
        active();
        if (!m.width || !m.height || m.width * m.height > 12000000 || (m.pages ?? 1) > 1)
          throw new BadRequestException(
            'La imagen debe ser una sola página de hasta 12 megapíxeles.',
          );
        let photo = await source
          .autoOrient()
          .rotate(options.rotation)
          .flatten({ background: '#ffffff' })
          .png()
          .toBuffer();
        active();
        if (options.crop) {
          const size = await sharp(photo).metadata(),
            c = options.crop;
          active();
          const left = Math.round(c.x * (size.width! - 1)),
            top = Math.round(c.y * (size.height! - 1));
          photo = await sharp(photo)
            .extract({
              left,
              top,
              width: Math.min(size.width! - left, Math.max(1, Math.round(c.width * size.width!))),
              height: Math.min(
                size.height! - top,
                Math.max(1, Math.round(c.height * size.height!)),
              ),
            })
            .png()
            .toBuffer();
          active();
        }
        const jpeg = await sharp(photo)
          .resize({ width: 2400, height: 3200, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 90 })
          .toBuffer();
        active();
        if (jpeg.length > 8 * 1024 * 1024)
          throw new BadRequestException('Recorta la imagen antes de enviarla a Gemini.');
        const { response, attempts } = await fetchGeminiWithRetry(
          this.fetcher,
          'https://generativelanguage.googleapis.com/v1beta/models/' +
            encodeURIComponent(model) +
            ':generateContent',
          {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: documentVisionInstruction }] },
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      text: 'Extrae los datos visibles del documento de esta fotografía usando el esquema. Revisa todas las filas y los textos del encabezado y del pie.',
                    },
                    { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
                  ],
                },
              ],
              generationConfig: {
                temperature: 0,
                responseMimeType: 'application/json',
                responseSchema: geminiResponseSchema,
                maxOutputTokens: 16384,
              },
            }),
          },
          deadlineAt,
          this.retryBaseMs(),
        );
        active();
        if (!response.ok) throw await googleFailure(response, attempts);
        const reader = response.body?.getReader();
        if (!reader)
          throw failure('GEMINI_INVALID_RESPONSE', 'Gemini devolvió una respuesta vacía.');
        const chunks: Uint8Array[] = [];
        let length = 0;
        while (true) {
          const part = await reader.read();
          active();
          if (part.done) break;
          length += part.value.length;
          if (length > 1024 * 1024) {
            await reader.cancel();
            throw failure(
              'GEMINI_INVALID_RESPONSE',
              'La respuesta del documento supera el tamaño permitido.',
            );
          }
          chunks.push(part.value);
        }
        let envelope: any;
        try {
          envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          throw failure(
            'GEMINI_INVALID_RESPONSE',
            'Gemini devolvió una respuesta que no pudo validarse.',
          );
        }
        const candidate = envelope.candidates?.[0];
        if (candidate?.finishReason !== 'STOP')
          throw failure(
            'GEMINI_INCOMPLETE',
            'Gemini no completó la lectura. Intenta con una página más nítida o recortada.',
          );
        const text = (candidate.content?.parts ?? [])
          .filter((p: any) => !p.thought && typeof p.text === 'string')
          .map((p: any) => p.text)
          .join('');
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw failure(
            'GEMINI_INVALID_RESPONSE',
            'Gemini no devolvió los datos estructurados esperados.',
          );
        }
        const parsed = geminiDocumentSchema.safeParse(json);
        if (!parsed.success)
          throw failure(
            'GEMINI_INVALID_RESPONSE',
            'Los datos devueltos por Gemini no cumplen el formato requerido. Reintenta la lectura.',
          );
        const reading = normalizeGeminiDocument(parsed.data);
        if (reading.lines.length === 0)
          throw failure(
            'GEMINI_NO_DOCUMENT',
            'No se identificaron artículos legibles. Recorta el papel o usa una foto más nítida.',
            422,
          );
        active();
        return {
          reading,
          rawText: parsed.data.text,
          confidence: null,
          imageHash,
          attempts,
          engine: 'gemini:' + model,
        };
      } catch (error) {
        if (reason) throw reason;
        if (error instanceof HttpException) throw error;
        throw failure(
          'GEMINI_UNAVAILABLE',
          'No se pudo completar la conexión con Gemini. Puedes volver a intentarlo.',
        );
      }
    };
    task.result = (async () => {
      try {
        const result = await Promise.race([operation(), stopped]);
        this.remember(id, fingerprint, result);
        return result;
      } finally {
        task.settled = true;
        clearTimeout(deadline);
        if (this.tasks.get(id) === task) this.tasks.delete(id);
        complete();
      }
    })();
    return this.waitFor(task, context.signal);
  }
  async cancel(principal: Principal, id: string) {
    const task = this.tasks.get(this.taskKey(principal, id));
    if (!task) return { cancelled: false };
    task.stop(cancelled());
    await task.done;
    return { cancelled: true };
  }
  async shutdown() {
    for (const entry of this.completed.values()) clearTimeout(entry.timer);
    this.completed.clear();
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.stop(cancelled());
    await Promise.all(tasks.map((t) => t.done));
  }
}
