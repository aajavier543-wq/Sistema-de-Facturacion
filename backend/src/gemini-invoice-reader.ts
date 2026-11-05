import { BadRequestException, HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { Principal } from './database';
import type { OcrOptions } from './ocr-options';
import type { OcrResult } from './invoice-ocr';
import {
  documentVisionInstruction,
  geminiDocumentSchema,
  geminiResponseSchema,
  normalizeGeminiDocument,
} from './gemini-document';
type Context = { principal?: Principal; requestId?: string; signal?: AbortSignal };
type Task = { principal?: Principal; stop: (error: HttpException) => void; done: Promise<void> };
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
    if (this.tasks.size >= 2)
      throw failure(
        'GEMINI_CAPACITY',
        'Hay dos lecturas de Gemini en curso. Espera unos segundos o cancela tu lectura anterior.',
        429,
      );
    const id = context.requestId ?? randomUUID();
    if (this.tasks.has(id))
      throw failure('GEMINI_IN_PROGRESS', 'Esta lectura ya está en curso.', 409);
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
      principal: context.principal,
      done,
      stop: (error) => {
        if (reason) return;
        reason = error;
        controller.abort();
        rejectStopped(error);
      },
    };
    this.tasks.set(id, task);
    const deadline = setTimeout(() => task.stop(timeout()), this.timeoutMs());
    const onAbort = () => task.stop(cancelled());
    context.signal?.addEventListener('abort', onAbort, { once: true });
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
        const response = await this.fetcher(
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
        );
        active();
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 429)
            throw failure(
              'GEMINI_QUOTA',
              'Gemini alcanzó la cuota disponible de tu cuenta. Espera a que se restablezca el cupo y vuelve a intentarlo; no se habilitó ningún plan de pago.',
              429,
            );
          if (response.status === 401 || response.status === 403)
            throw failure(
              'GEMINI_AUTH',
              'La clave de Gemini no tiene acceso. Revisa la clave y el proyecto en Google AI Studio.',
            );
          if (response.status === 404)
            throw failure(
              'GEMINI_MODEL_UNAVAILABLE',
              'El modelo configurado no está disponible para esta cuenta. Revisa GEMINI_MODEL.',
            );
          throw failure(
            'GEMINI_UNAVAILABLE',
            'Gemini no pudo procesar la solicitud. Vuelve a intentarlo más tarde.',
          );
        }
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
          imageHash: createHash('sha256').update(file.buffer).digest('hex'),
          attempts: 1,
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
    try {
      if (context.signal?.aborted) onAbort();
      return await Promise.race([operation(), stopped]);
    } finally {
      clearTimeout(deadline);
      context.signal?.removeEventListener('abort', onAbort);
      if (this.tasks.get(id) === task) this.tasks.delete(id);
      complete();
    }
  }
  async cancel(principal: Principal, id: string) {
    const task = this.tasks.get(id);
    if (
      !task ||
      task.principal?.tenantId !== principal.tenantId ||
      task.principal?.userId !== principal.userId
    )
      return { cancelled: false };
    task.stop(cancelled());
    await task.done;
    return { cancelled: true };
  }
  async shutdown() {
    const tasks = [...this.tasks.values()];
    for (const task of tasks) task.stop(cancelled());
    await Promise.all(tasks.map((t) => t.done));
  }
}
