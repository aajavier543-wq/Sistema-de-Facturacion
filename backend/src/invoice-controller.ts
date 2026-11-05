import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Post,
  Req,
  Res,
  HttpCode,
  HttpException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthRequest, requireAdmin, TenantGuard } from './auth';
import { Database } from './database';
import { InvoiceOcr, ocrOptionsSchema } from './invoice-ocr';
import { InvoiceImporter, invoiceReviewSchema } from './invoice-import';
import { parse, uuid } from './validation';
import { z } from 'zod';
import type { Response } from 'express';
import { invoiceExample } from './invoice-example';
import { seedInvoiceExample } from './catalog-import';

@Controller('goods/invoice-images')
@UseGuards(TenantGuard)
export class InvoiceImageController {
  constructor(
    private readonly db: Database,
    private readonly ocr: InvoiceOcr,
    private readonly importer: InvoiceImporter,
  ) {}
  @Post('read')
  @UseInterceptors(
    FileInterceptor('image', { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2 } }),
  )
  async read(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
    @Body('options') options: unknown,
    @Body('requestId') requestId: unknown,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined,
  ) {
    requireAdmin(req.principal);
    let input: unknown = {};
    if (options !== undefined) {
      if (typeof options !== 'string' || options.length > 1000)
        throw new BadRequestException('Opciones de lectura inválidas');
      try {
        input = JSON.parse(options);
      } catch {
        throw new BadRequestException('Opciones de lectura inválidas');
      }
    }
    const id = requestId === undefined ? undefined : parse(uuid, requestId);
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', disconnect);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      return await this.ocr.recognize(file, parse(ocrOptionsSchema, input), {
        principal: req.principal,
        requestId: id,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429)
        res.setHeader('Retry-After', '2');
      throw error;
    } finally {
      res.removeListener('close', disconnect);
    }
  }
  @Post('cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthRequest, @Body() body: unknown) {
    requireAdmin(req.principal);
    const { requestId } = parse(z.object({ requestId: uuid }).strict(), body);
    return this.ocr.cancel(req.principal, requestId);
  }
  @Get('example') example(@Req() req: AuthRequest) {
    requireAdmin(req.principal);
    return {
      reading: {
        ...invoiceExample,
        documentType: 'invoice',
        lines: invoiceExample.lines.map((l) => ({ ...l, printedTotal: null })),
      },
      rawText: 'Transcripción del ejemplo proporcionado por el usuario; no es un resultado OCR.',
      imageHash: null,
      confidence: null,
      sourceKind: 'example',
    };
  }
  @Post('example/catalog') seed(@Req() req: AuthRequest) {
    requireAdmin(req.principal);
    return this.db.transaction(req.principal, (c) => seedInvoiceExample(c, req.principal));
  }
  @Post('apply') apply(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.importer.apply(req.principal, parse(invoiceReviewSchema, body));
  }
}
