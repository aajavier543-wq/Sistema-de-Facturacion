import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthRequest, AuthService, requireAdmin, TenantGuard } from './auth';
import { Database } from './database';
import { InventoryService } from './inventory';
import { money, parse, uuid } from './validation';
import { calculateQuote, QuoteLine } from './taxes';
import { hashToken } from './security';

@Controller()
export class HealthController {
  constructor(private readonly db: Database) {}
  @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Get('health/ready') async ready() {
    try {
      await this.db.pool.query('SELECT 1 FROM products LIMIT 0');
      return { status: 'ok', database: 'connected' };
    } catch {
      throw new ServiceUnavailableException('Base de datos no disponible o sin migrar');
    }
  }
}
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly db: Database,
  ) {}
  @Post('login') async login(@Body() body: unknown) {
    const data = parse(
      z
        .object({
          email: z
            .email()
            .max(254)
            .transform((s) => s.toLowerCase()),
          password: z.string().min(1).max(128),
        })
        .strict(),
      body,
    );
    return this.auth.login(data.email, data.password);
  }
  @Delete('session')
  @UseGuards(TenantGuard)
  async logout(@Req() req: AuthRequest) {
    await this.db.pool.query('DELETE FROM sessions WHERE token_hash=$1', [
      hashToken(req.headers.authorization!.slice(7)),
    ]);
    return { revoked: true };
  }
  @Get('me')
  @UseGuards(TenantGuard)
  me(@Req() req: AuthRequest) {
    return req.principal;
  }
}

@Controller()
@UseGuards(TenantGuard)
export class BusinessController {
  constructor(
    private readonly db: Database,
    private readonly inventory: InventoryService,
  ) {}
  @Get('branches') branches(@Req() req: AuthRequest) {
    return this.db.transaction(
      req.principal,
      async (c) => (await c.query('SELECT id,name FROM branches ORDER BY name')).rows,
    );
  }
  @Post('branches') createBranch(@Req() req: AuthRequest, @Body() body: unknown) {
    requireAdmin(req.principal);
    const input = parse(z.object({ name: z.string().trim().min(1).max(120) }).strict(), body);
    return this.db.transaction(
      req.principal,
      async (c) =>
        (
          await c.query('INSERT INTO branches(tenant_id,name) VALUES($1,$2) RETURNING id,name', [
            req.principal.tenantId,
            input.name,
          ])
        ).rows[0],
    );
  }
  @Get('products') products(@Req() req: AuthRequest, @Query() query: unknown) {
    const q = parse(
      z
        .object({
          search: z.string().max(120).default(''),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict(),
      query,
    );
    return this.db.transaction(
      req.principal,
      async (c) =>
        (
          await c.query(
            `SELECT id,sku,barcode,name,price_usd,tax_category
      FROM products WHERE active AND (strpos(lower(name),lower($1))>0 OR sku=$1 OR barcode=$1)
      ORDER BY name,id LIMIT $2 OFFSET $3`,
            [q.search, q.limit, q.offset],
          )
        ).rows,
    );
  }
  @Post('products') createProduct(@Req() req: AuthRequest, @Body() body: unknown) {
    requireAdmin(req.principal);
    const p = parse(
      z
        .object({
          sku: z.string().trim().min(1).max(64),
          barcode: z.string().trim().min(1).max(64).optional(),
          name: z.string().trim().min(1).max(200),
          priceUsd: money,
          taxCategory: z.enum(['general', 'reduced', 'exempt']),
        })
        .strict(),
      body,
    );
    return this.db.transaction(req.principal, async (c) => {
      const result = await c.query(
        `INSERT INTO products(tenant_id,sku,barcode,name,price_usd,tax_category)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,sku,barcode,name,price_usd,tax_category`,
        [req.principal.tenantId, p.sku, p.barcode ?? null, p.name, p.priceUsd, p.taxCategory],
      );
      await c.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
        VALUES($1,$2,'product.create',$3,$4)`,
        [req.principal.tenantId, req.principal.userId, result.rows[0].id, JSON.stringify(p)],
      );
      return result.rows[0];
    });
  }
  @Get('branches/:branchId/stock') stock(
    @Req() req: AuthRequest,
    @Param('branchId') branchId: string,
  ) {
    const id = parse(uuid, branchId);
    return this.db.transaction(
      req.principal,
      async (c) =>
        (
          await c.query(
            `SELECT s.product_id,p.sku,p.name,s.quantity,s.version
      FROM stock_balances s JOIN products p ON p.tenant_id=s.tenant_id AND p.id=s.product_id
      WHERE s.branch_id=$1 ORDER BY p.name LIMIT 500`,
            [id],
          )
        ).rows,
    );
  }
  @Post('inventory/adjustments') adjust(@Req() req: AuthRequest, @Body() body: unknown) {
    const data = parse(
      z
        .object({
          branchId: uuid,
          productId: uuid,
          idempotencyKey: uuid,
          delta: z
            .string()
            .regex(/^-?(0|[1-9]\d{0,11})(\.\d{1,6})?$/)
            .refine((s) => !/^(-)?0(\.0+)?$/.test(s), 'El ajuste no puede ser cero'),
          reason: z.string().trim().min(5).max(250),
        })
        .strict(),
      body,
    );
    return this.inventory.adjust(req.principal, data);
  }
  @Post('quotes/preview') async quote(@Req() req: AuthRequest, @Body() body: unknown) {
    const data = parse(
      z
        .object({
          rate: money.refine((s) => Number(s) > 0),
          lines: z
            .array(
              z.object({ productId: uuid, quantity: money.refine((s) => Number(s) > 0) }).strict(),
            )
            .min(1)
            .max(100),
          payments: z
            .array(z.object({ principalUsd: money, eligibleForIgtf: z.boolean() }).strict())
            .max(20)
            .default([]),
        })
        .strict(),
      body,
    );
    const lines: QuoteLine[] = await this.db.transaction(req.principal, async (c) => {
      const { rows } = await c.query(
        'SELECT id,price_usd,tax_category FROM products WHERE id=ANY($1::uuid[]) AND active',
        [data.lines.map((l) => l.productId)],
      );
      return data.lines.map((l) => {
        const p = rows.find((p) => p.id === l.productId);
        if (!p) throw new BadRequestException('Producto no disponible');
        return { quantity: l.quantity, priceUsd: p.price_usd, taxCategory: p.tax_category };
      });
    });
    try {
      return calculateQuote(lines, data.rate, data.payments);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
