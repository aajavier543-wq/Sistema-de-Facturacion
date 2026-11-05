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
import { createWorker } from 'tesseract.js';
import { parseInvoiceText } from './invoice-parser';

@Injectable()
export class InvoiceOcr {
  private busy = false;
  async recognize(file: { buffer: Buffer; mimetype: string; size: number } | undefined) {
    if (!file || !Buffer.isBuffer(file.buffer))
      throw new BadRequestException('Selecciona una imagen de factura');
    if (file.size > 8 * 1024 * 1024)
      throw new BadRequestException('La imagen no puede superar 8 MB');
    const b = file.buffer;
    const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const png = b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp =
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP';
    if (!jpeg && !png && !webp)
      throw new BadRequestException('Solo se admiten imágenes JPEG, PNG o WebP reales');
    if (this.busy)
      throw new HttpException(
        'Hay una factura en lectura. Intenta nuevamente en unos segundos.',
        429,
      );
    this.busy = true;
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      const image = await input
        .rotate()
        .resize({ width: 1800, height: 2400, fit: 'inside', withoutEnlargement: false })
        .greyscale()
        .normalise()
        .png()
        .toBuffer();
      const dimensions = await sharp(image).metadata();
      const header = await sharp(image)
        .extract({
          left: 0,
          top: 0,
          width: dimensions.width!,
          height: Math.max(1, Math.floor(dimensions.height! * 0.2)),
        })
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
        const full = await worker!.recognize(image);
        const top = await worker!.recognize(header);
        return {
          rawText: full.data.text.slice(0, 50000),
          reading: parseInvoiceText(full.data.text, top.data.text),
          confidence: Math.round(full.data.confidence),
          imageHash: createHash('sha256').update(b).digest('hex'),
        };
      };
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ServiceUnavailableException(
                'La lectura tardó demasiado. Prueba una foto más nítida, recta o de menor tamaño.',
              ),
            ),
          60000,
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
