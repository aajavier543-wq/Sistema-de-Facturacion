import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ConflictException,
  NotFoundException,
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
            `SELECT id,sku,barcode,name,price_usd,tax_category,version
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
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id,sku,barcode,name,price_usd,tax_category,version`,
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
  @Patch('products/:productId') updateProduct(
    @Req() req: AuthRequest,
    @Param('productId') productId: string,
    @Body() body: unknown,
  ) {
    requireAdmin(req.principal);
    const id = parse(uuid, productId);
    const p = parse(
      z
        .object({
          name: z.string().trim().min(1).max(200),
          barcode: z.string().trim().min(1).max(64).nullable(),
          priceUsd: money,
          taxCategory: z.enum(['general', 'reduced', 'exempt']),
          expectedVersion: z.number().int().min(0),
        })
        .strict(),
      body,
    );
    return this.db.transaction(req.principal, async (c) => {
      const before = await c.query('SELECT * FROM products WHERE id=$1 AND active FOR UPDATE', [
        id,
      ]);
      if (!before.rowCount) throw new NotFoundException('Artículo no disponible');
      if (before.rows[0].version !== p.expectedVersion)
        throw new ConflictException(
          'El artículo fue modificado por otro usuario. Actualiza la consulta y vuelve a abrir la ficha.',
        );
      const updated = await c.query(
        `UPDATE products SET name=$2,barcode=$3,price_usd=$4,tax_category=$5,version=version+1
        WHERE id=$1 RETURNING id,sku,barcode,name,price_usd,tax_category,version`,
        [id, p.name, p.barcode, p.priceUsd, p.taxCategory],
      );
      await c.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
        VALUES($1,$2,'product.update',$3,$4)`,
        [
          req.principal.tenantId,
          req.principal.userId,
          id,
          JSON.stringify({ before: before.rows[0], after: updated.rows[0] }),
        ],
      );
      return updated.rows[0];
    });
  }
  @Get('dashboard') summary(@Req() req: AuthRequest, @Query() query: unknown) {
    const q = parse(z.object({ branchId: uuid }).strict(), query);
    return this.db.transaction(req.principal, async (c) => {
      if (!(await c.query('SELECT id FROM branches WHERE id=$1', [q.branchId])).rowCount)
        throw new NotFoundException('Sucursal no disponible');
      const result = await c.query(
        `SELECT count(*)::int AS products,
        count(*) FILTER(WHERE coalesce(s.quantity,0)>0)::int AS with_stock,
        count(*) FILTER(WHERE coalesce(s.quantity,0)=0)::int AS without_stock
        FROM products p LEFT JOIN stock_balances s ON p.tenant_id=s.tenant_id AND p.id=s.product_id AND s.branch_id=$1
        WHERE p.active`,
        [q.branchId],
      );
      const branches = await c.query('SELECT count(*)::int AS count FROM branches');
      return { ...result.rows[0], branches: branches.rows[0].count };
    });
  }
  @Get('inventory/stock') pagedStock(@Req() req: AuthRequest, @Query() query: unknown) {
    const q = parse(
      z
        .object({
          branchId: uuid,
          search: z.string().max(120).default(''),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict(),
      query,
    );
    return this.db.transaction(req.principal, async (c) => {
      if (!(await c.query('SELECT id FROM branches WHERE id=$1', [q.branchId])).rowCount)
        throw new NotFoundException('Sucursal no disponible');
      const where = 'p.active AND (strpos(lower(p.name),lower($1))>0 OR p.sku=$1 OR p.barcode=$1)';
      const count = await c.query(`SELECT count(*)::int AS total FROM products p WHERE ${where}`, [
        q.search,
      ]);
      const rows = await c.query(
        `SELECT p.id,p.sku,p.barcode,p.name,p.price_usd,p.tax_category,p.version,
        coalesce(s.quantity,0)::text AS quantity FROM products p
        LEFT JOIN stock_balances s ON p.tenant_id=s.tenant_id AND p.id=s.product_id AND s.branch_id=$2
        WHERE ${where} ORDER BY p.name,p.id LIMIT $3 OFFSET $4`,
        [q.search, q.branchId, q.limit, q.offset],
      );
      return { items: rows.rows, total: count.rows[0].total };
    });
  }
  @Get('inventory/movements') movements(@Req() req: AuthRequest, @Query() query: unknown) {
    const q = parse(
      z
        .object({
          branchId: uuid,
          search: z.string().max(120).default(''),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict(),
      query,
    );
    return this.db.transaction(req.principal, async (c) => {
      if (!(await c.query('SELECT id FROM branches WHERE id=$1', [q.branchId])).rowCount)
        throw new NotFoundException('Sucursal no disponible');
      const clause = `FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
        JOIN users u ON u.id=m.actor_id WHERE m.branch_id=$1
        AND (strpos(lower(p.name),lower($2))>0 OR p.sku=$2 OR strpos(lower(m.reason),lower($2))>0)`;
      const count = await c.query(`SELECT count(*)::int AS total ${clause}`, [
        q.branchId,
        q.search,
      ]);
      const rows = await c.query(
        `SELECT m.id,m.created_at,m.delta,m.reason,p.sku,p.name,u.email AS actor
        ${clause} ORDER BY m.created_at DESC,m.id DESC LIMIT $3 OFFSET $4`,
        [q.branchId, q.search, q.limit, q.offset],
      );
      return { items: rows.rows, total: count.rows[0].total };
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
    const lines: (QuoteLine & { productId: string; sku: string; name: string })[] =
      await this.db.transaction(req.principal, async (c) => {
        const { rows } = await c.query(
          'SELECT id,sku,name,price_usd,tax_category FROM products WHERE id=ANY($1::uuid[]) AND active',
          [data.lines.map((l) => l.productId)],
        );
        return data.lines.map((l) => {
          const p = rows.find((p) => p.id === l.productId);
          if (!p) throw new BadRequestException('Producto no disponible');
          return {
            productId: p.id,
            sku: p.sku,
            name: p.name,
            quantity: l.quantity,
            priceUsd: p.price_usd,
            taxCategory: p.tax_category,
          };
        });
      });
    try {
      const result = calculateQuote(lines, data.rate, data.payments);
      return {
        ...result,
        lines: result.lines.map((line, index) => ({
          ...line,
          productId: lines[index]!.productId,
          sku: lines[index]!.sku,
          name: lines[index]!.name,
          quantity: lines[index]!.quantity,
          priceUsd: lines[index]!.priceUsd,
        })),
      };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
