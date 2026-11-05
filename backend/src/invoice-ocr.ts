import {
  BadRequestException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM, type Page } from 'tesseract.js';
import { z } from 'zod';
import { parseInvoiceText, readingScore, type InvoiceReading } from './invoice-parser';
import { spatialText, type OcrWord } from './document-layout';
export const ocrOptionsSchema = z
  .object({
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
    detailed: z.boolean().default(false),
    crop: z
      .object({
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().min(0.05).max(1),
        height: z.number().min(0.05).max(1),
      })
      .strict()
      .refine((v) => v.x + v.width <= 1.000001 && v.y + v.height <= 1.000001)
      .nullable()
      .default(null),
  })
  .strict();
export type OcrOptions = z.infer<typeof ocrOptionsSchema>;
function wordsOf(page: Page): OcrWord[] {
  return (page.blocks ?? [])
    .flatMap((b) =>
      b.paragraphs.flatMap((p) =>
        p.lines.flatMap((l) =>
          l.words.map((w) => ({ text: w.text, ...w.bbox, confidence: w.confidence })),
        ),
      ),
    )
    .slice(0, 15000);
}
function isComplete(d: InvoiceReading) {
  return (
    d.documentType !== 'unknown' &&
    d.supplierRif !== null &&
    d.invoiceNumber !== null &&
    d.documentDate !== null &&
    (d.documentType !== 'invoice' || d.controlNumber !== null) &&
    d.declaredTotal !== null &&
    d.lines.length > 0 &&
    d.lines.every((l) => !l.needsReview && l.quantity !== null && l.unitCost !== null) &&
    !d.warnings.some((w) => /no coincide/.test(w))
  );
}
/** Compensate uneven illumination using a small local background map, bounded to the resized page. */
async function normalizeLighting(image: Buffer) {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const background = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: 1 },
  })
    .resize(64, 64, { fit: 'fill' })
    .blur(3)
    .resize(info.width, info.height, { fit: 'fill' })
    .raw()
    .toBuffer();
  const corrected = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++)
    corrected[i] = Math.min(255, Math.round((data[i]! * 245) / Math.max(90, background[i]!)));
  return sharp(corrected, { raw: { width: info.width, height: info.height, channels: 1 } })
    .normalise()
    .sharpen()
    .png()
    .toBuffer();
}
@Injectable()
export class InvoiceOcr {
  private busy = false;
  async recognize(
    file: { buffer: Buffer; mimetype: string; size: number } | undefined,
    options: OcrOptions = { rotation: 0, detailed: false, crop: null },
  ) {
    if (!file || !Buffer.isBuffer(file.buffer))
      throw new BadRequestException('Selecciona una imagen del documento');
    if (file.size > 8 * 1024 * 1024 || file.buffer.length > 8 * 1024 * 1024)
      throw new BadRequestException('La imagen no puede superar 8 MB');
    const b = file.buffer,
      jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
      png = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      webp =
        b.length > 12 &&
        b.toString('ascii', 0, 4) === 'RIFF' &&
        b.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp)
      throw new BadRequestException('Solo se admiten imágenes JPEG, PNG o WebP reales');
    if (this.busy)
      throw new HttpException(
        { message: 'Hay un documento en lectura. Intenta nuevamente en unos segundos.' },
        429,
      );
    this.busy = true;
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null,
      timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const input = sharp(b, { limitInputPixels: 12000000, animated: false });
      const meta = await input.metadata();
      if (
        !meta.width ||
        !meta.height ||
        meta.width * meta.height > 12000000 ||
        (meta.pages ?? 1) > 1
      )
        throw new BadRequestException('La imagen debe ser una sola página de hasta 12 megapíxeles');
      let page = await input
        .autoOrient()
        .rotate(options.rotation)
        .flatten({ background: '#ffffff' })
        .greyscale()
        .png()
        .toBuffer();
      if (options.crop) {
        const m = await sharp(page).metadata(),
          c = options.crop;
        const left = Math.round(c.x * (m.width! - 1)),
          top = Math.round(c.y * (m.height! - 1));
        page = await sharp(page)
          .extract({
            left,
            top,
            width: Math.min(m.width! - left, Math.max(1, Math.round(c.width * m.width!))),
            height: Math.min(m.height! - top, Math.max(1, Math.round(c.height * m.height!))),
          })
          .png()
          .toBuffer();
      }
      const image = await sharp(page)
        .resize({ width: 2200, height: 3000, fit: 'inside' })
        .normalise()
        .png()
        .toBuffer();
      const cachePath = '/tmp/nexo-ocr-cache';
      await mkdir(cachePath, { recursive: true });
      worker = await createWorker('spa', 1, {
        langPath: resolve(__dirname, '../../../resources/ocr'),
        cachePath,
        gzip: true,
        logger: () => {},
        errorHandler: () => {},
      });
      const recognize = async () => {
        let best: { reading: InvoiceReading; rawText: string; confidence: number } | null = null,
          attempts = 0;
        const attempt = async (buffer: Buffer, mode: PSM) => {
          await worker!.setParameters({
            tessedit_pageseg_mode: mode,
            preserve_interword_spaces: '1',
            user_defined_dpi: '300',
          });
          const r = await worker!.recognize(
            buffer,
            { rotateAuto: true },
            { text: true, blocks: true },
          );
          attempts++;
          const words = wordsOf(r.data),
            spatial = spatialText(words),
            plain = r.data.text;
          const candidates = [
            { reading: parseInvoiceText(spatial, spatial, words), rawText: spatial },
            { reading: parseInvoiceText(plain, plain), rawText: plain },
          ];
          for (const c of candidates) {
            const candidate = {
              ...c,
              rawText: c.rawText.slice(0, 50000),
              confidence: Math.round(r.data.confidence),
            };
            if (!best || readingScore(candidate.reading) > readingScore(best.reading))
              best = candidate;
          }
        };
        await attempt(image, PSM.AUTO);
        if (options.detailed || !isComplete(best!.reading)) await attempt(image, PSM.SPARSE_TEXT);
        if (options.detailed || !isComplete(best!.reading))
          await attempt(await normalizeLighting(image), PSM.SINGLE_BLOCK);
        const chosen = best!;
        if (chosen.reading.lines.length === 0)
          chosen.reading.warnings.push(
            'Prueba la lectura detallada, gira la imagen o selecciona solo el área del documento para excluir el fondo.',
          );
        return {
          ...chosen,
          imageHash: createHash('sha256').update(b).digest('hex'),
          attempts,
          engine: 'tesseract-layout-v2',
        };
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ServiceUnavailableException(
                'La lectura tardó demasiado. Recorta los bordes o usa una foto más nítida.',
              ),
            ),
          90000,
        );
      });
      return await Promise.race([recognize(), timeout]);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new BadRequestException(
        'No se pudo leer esta imagen. Usa una fotografía nítida en JPEG, PNG o WebP.',
      );
    } finally {
      if (timer) clearTimeout(timer);
      if (worker) await worker.terminate().catch(() => {});
      this.busy = false;
    }
  }
}
