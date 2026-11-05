import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AuthRequest, requireAdmin, TenantGuard } from './auth';
import { Database } from './database';
import { InvoiceOcr } from './invoice-ocr';
import { InvoiceImporter, invoiceReviewSchema } from './invoice-import';
import { parse } from './validation';
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
  read(
    @Req() req: AuthRequest,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; size: number } | undefined,
  ) {
    requireAdmin(req.principal);
    return this.ocr.recognize(file);
  }
  @Get('example') example(@Req() req: AuthRequest) {
    requireAdmin(req.principal);
    return {
      reading: {
        ...invoiceExample,
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
