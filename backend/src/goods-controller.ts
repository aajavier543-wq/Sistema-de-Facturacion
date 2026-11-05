import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthRequest, requireAdmin, TenantGuard } from './auth';
import { Database } from './database';
import { GoodsService } from './goods';
import { goodsChecks, goodsSchema } from './goods-validation';
import { parse, uuid } from './validation';

@Controller('goods')
@UseGuards(TenantGuard)
export class GoodsController {
  constructor(
    private readonly db: Database,
    private readonly goods: GoodsService,
  ) {}
  @Get('suppliers') suppliers(@Req() req: AuthRequest, @Query() query: unknown) {
    requireAdmin(req.principal);
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
            `SELECT id,rif,name FROM suppliers
     WHERE strpos(lower(name),lower($1))>0 OR strpos(rif,upper($1))>0 ORDER BY name,id LIMIT $2 OFFSET $3`,
            [q.search, q.limit, q.offset],
          )
        ).rows,
    );
  }
  @Post('suppliers') createSupplier(@Req() req: AuthRequest, @Body() body: unknown) {
    requireAdmin(req.principal);
    const data = parse(
      z
        .object({
          rif: z
            .string()
            .trim()
            .transform((s) => s.toUpperCase().replace(/[-\s]/g, ''))
            .pipe(
              z.string().regex(/^[VJEGP]\d{9}$/, 'RIF inválido; usa, por ejemplo, J-12345678-9'),
            ),
          name: z.string().trim().min(2).max(200),
        })
        .strict(),
      body,
    );
    return this.db.transaction(req.principal, async (c) => {
      const r = await c.query(
        'INSERT INTO suppliers(tenant_id,rif,name) VALUES($1,$2,$3) RETURNING id,rif,name',
        [req.principal.tenantId, data.rif, data.name],
      );
      await c.query(
        `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details) VALUES($1,$2,'supplier.create',$3,$4)`,
        [req.principal.tenantId, req.principal.userId, r.rows[0].id, JSON.stringify(data)],
      );
      return r.rows[0];
    });
  }
  @Get('documents') list(@Req() req: AuthRequest, @Query() query: unknown) {
    const q = parse(
      z
        .object({
          kind: z.enum(['adjustment', 'purchase']),
          branchId: uuid,
          search: z.string().max(120).default(''),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).max(100000).default(0),
        })
        .strict(),
      query,
    );
    return this.goods.list(req.principal, q);
  }
  @Get('documents/:id') get(@Req() req: AuthRequest, @Param('id') id: string) {
    return this.goods.get(req.principal, parse(uuid, id));
  }
  @Post('documents/preview') preview(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.goods.preview(req.principal, parse(goodsSchema.superRefine(goodsChecks), body));
  }
  @Post('documents') create(@Req() req: AuthRequest, @Body() body: unknown) {
    const { idempotencyKey, ...data } = parse(
      goodsSchema.extend({ idempotencyKey: uuid }).superRefine(goodsChecks),
      body,
    );
    return this.goods.save(req.principal, data, idempotencyKey);
  }
  @Patch('documents/:id') update(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { expectedVersion, ...data } = parse(
      goodsSchema.extend({ expectedVersion: z.number().int().min(0) }).superRefine(goodsChecks),
      body,
    );
    return this.goods.save(req.principal, data, null, parse(uuid, id), expectedVersion);
  }
  @Post('documents/:id/confirm') confirm(
    @Req() req: AuthRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = parse(z.object({ expectedVersion: z.number().int().min(0) }).strict(), body);
    return this.goods.confirm(req.principal, parse(uuid, id), data.expectedVersion);
  }
}
