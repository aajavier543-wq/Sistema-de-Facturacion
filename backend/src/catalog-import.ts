import { ConflictException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { Principal } from './database';
import { invoiceExample } from './invoice-example';
export const normalizeProductName = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Matches are explicit or unique by normalized full name. Never merges vaguely similar medicines. */
export async function resolveImportProduct(
  c: PoolClient,
  p: Principal,
  input: {
    name: string;
    productId?: string | null;
    sourceKey?: string | null;
    sku?: string | null;
    taxRate: string;
  },
) {
  if (input.productId) {
    const existing = (
      await c.query('SELECT id,sku,name FROM products WHERE id=$1 AND active', [input.productId])
    ).rows[0];
    if (!existing) throw new ConflictException('El artículo seleccionado no está disponible');
    return { product: existing, created: false };
  }
  if (input.sourceKey) {
    const bySource = (
      await c.query('SELECT id,sku,name FROM products WHERE catalog_source_key=$1', [
        input.sourceKey,
      ])
    ).rows[0];
    if (bySource) return { product: bySource, created: false };
  }
  const normalized = normalizeProductName(input.name);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    'catalog-import:' + p.tenantId + ':' + normalized,
  ]);
  if (input.sourceKey) {
    const bySource = (
      await c.query('SELECT id,sku,name FROM products WHERE catalog_source_key=$1', [
        input.sourceKey,
      ])
    ).rows[0];
    if (bySource) return { product: bySource, created: false };
  }
  // Scope is already restricted by RLS. Inspect complete names, not fuzzy ingredient matches.
  const matches = (
    await c.query(
      `SELECT id,sku,name FROM products WHERE active
   AND btrim(regexp_replace(upper(translate(name,'áéíóúüñÁÉÍÓÚÜÑ','aeiouunAEIOUUN')),'\\s+',' ','g'))=$1 LIMIT 2`,
      [normalized],
    )
  ).rows;
  if (matches.length > 1)
    throw new ConflictException(
      'Hay varios artículos con esta descripción; selecciona el código correcto: ' + input.name,
    );
  if (matches[0]) {
    if (input.sourceKey)
      await c.query(
        'UPDATE products SET catalog_source_key=COALESCE(catalog_source_key,$2) WHERE id=$1',
        [matches[0].id, input.sourceKey],
      );
    return { product: matches[0], created: false };
  }
  let sku = input.sku ?? 'IMP-' + randomUUID().slice(0, 12).toUpperCase();
  if ((await c.query('SELECT id FROM products WHERE sku=$1', [sku])).rowCount)
    sku = 'IMP-' + randomUUID();
  const created = await c.query(
    `INSERT INTO products(tenant_id,sku,name,price_usd,tax_category,price_pending,catalog_source_key)
  VALUES($1,$2,$3,0,$4,true,$5) RETURNING id,sku,name`,
    [
      p.tenantId,
      sku,
      input.name,
      input.taxRate === '16' ? 'general' : input.taxRate === '8' ? 'reduced' : 'exempt',
      input.sourceKey ?? null,
    ],
  );
  await c.query(
    `INSERT INTO audit_events(tenant_id,actor_id,action,entity_id,details)
  VALUES($1,$2,'product.import',$3,$4)`,
    [
      p.tenantId,
      p.userId,
      created.rows[0].id,
      JSON.stringify({ name: input.name, sourceKey: input.sourceKey ?? null, pricePending: true }),
    ],
  );
  return { product: created.rows[0], created: true };
}
export async function seedInvoiceExample(c: PoolClient, p: Principal) {
  let created = 0;
  for (const line of [...invoiceExample.lines].sort((a, b) =>
    normalizeProductName(a.name).localeCompare(normalizeProductName(b.name), 'en'),
  )) {
    const resolved = await resolveImportProduct(c, p, {
      name: line.name,
      sourceKey: line.sourceKey,
      sku: line.sku,
      taxRate: line.taxRate,
    });
    if (resolved.created) created++;
  }
  return {
    created,
    existing: invoiceExample.lines.length - created,
    total: invoiceExample.lines.length,
  };
}
