import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { createWorker, PSM, type Page } from 'tesseract.js';
import { parseInvoiceText, readingScore, type InvoiceReading } from './invoice-parser';
import { spatialText, type OcrWord } from './document-layout';
import type { OcrOptions } from './ocr-options';
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

/** Only executed in the disposable OCR process. The parent enforces the complete deadline. */
export async function runInvoiceOcr(b: Buffer, options: OcrOptions) {
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  try {
    const input = sharp(b, { limitInputPixels: 12000000, animated: false });
    const meta = await input.metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > 12000000 || (meta.pages ?? 1) > 1)
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
    worker = await createWorker('spa', 1, {
      langPath: resolve(__dirname, '../../../resources/ocr'),
      cacheMethod: 'none',
      gzip: true,
      logger: () => {},
      errorHandler: () => {
        process.send?.({ type: 'error', code: 'OCR_ENGINE_FAILED' });
        setImmediate(() => process.exit(1));
      },
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
    return await recognize();
  } finally {
    // Do not make a successful result wait on worker shutdown. The parent reaps this process.
    if (worker) void worker.terminate().catch(() => {});
  }
}
