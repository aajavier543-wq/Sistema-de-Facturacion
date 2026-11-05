import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Response } from 'express';
import { Database } from './database';
import { AuthService, TenantGuard } from './auth';
import { InventoryService } from './inventory';
import { GoodsService } from './goods';
import { GoodsController } from './goods-controller';
import { InvoiceImageController } from './invoice-controller';
import { InvoiceImporter } from './invoice-import';
import { InvoiceOcr } from './invoice-ocr';
import { AuthController, BusinessController, HealthController } from './controllers';

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException)
      return response.status(error.getStatus()).json(error.getResponse());
    const code = (error as { code?: string })?.code;
    if (code === '23505')
      return response.status(409).json({
        message:
          (error as { constraint?: string }).constraint === 'purchase_invoice_unique'
            ? 'El proveedor ya tiene un documento de este tipo registrado con ese número.'
            : (error as { constraint?: string }).constraint === 'invoice_image_once'
              ? 'Esta imagen ya fue importada en la empresa.'
              : 'Registro duplicado',
      });
    if (code === '23503' || code === '23514')
      return response.status(400).json({ message: 'Referencia o valor inválido' });
    if (code === '42501') return response.status(403).json({ message: 'Operación no autorizada' });
    if (code === '40P01' || code === '40001')
      return response
        .status(409)
        .json({ message: 'Conflicto concurrente; reintente con la misma clave' });
    // Do not expose SQL, credentials or request bodies in responses/logs.
    console.error('Unexpected API failure', { code: code ?? 'unknown' });
    return response.status(500).json({ message: 'Error interno' });
  }
}
@Module({
  controllers: [
    HealthController,
    AuthController,
    BusinessController,
    GoodsController,
    InvoiceImageController,
  ],
  providers: [
    Database,
    AuthService,
    TenantGuard,
    InventoryService,
    GoodsService,
    InvoiceImporter,
    InvoiceOcr,
    { provide: APP_FILTER, useClass: ApiErrors },
  ],
})
export class AppModule {}
