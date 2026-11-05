import 'reflect-metadata';
import 'dotenv/config';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { INestApplication } from '@nestjs/common';
import { chromium } from 'playwright-core';
import { createApplication } from '../src/create-app';
import { Database, Principal } from '../src/database';
import { migrate } from '../scripts/migrate';
import { hashPassword } from '../src/security';
import { invoiceExample } from '../src/invoice-example';
import { invoiceImage } from './invoice-fixture';

const dbName = 'goods_test_' + randomBytes(6).toString('hex');
const tenant = randomUUID(),
  foreignTenant = randomUUID(),
  user = randomUUID(),
  foreignUser = randomUUID(),
  cashier = randomUUID();
const branch = randomUUID(),
  foreignBranch = randomUUID();
const password = randomBytes(24).toString('hex');
const principal: Principal = { tenantId: tenant, userId: user, role: 'admin' };
let admin: Pool,
  owner: Pool,
  app: INestApplication,
  db: Database,
  base: string,
  token: string,
  foreignToken: string,
  cashierToken: string;
let supplier: string,
  foreignSupplier: string,
  p1: string,
  p2: string,
  browserProduct: string,
  firstDocument: any;
async function request(
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  who = token,
  company = tenant,
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + who,
      'x-tenant-id': company,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function product(sku: string, company = tenant) {
  return (
    await owner.query(
      `INSERT INTO products(tenant_id,sku,name,price_usd,tax_category) VALUES($1,$2,$2,100,'general') RETURNING id`,
      [company, sku],
    )
  ).rows[0].id as string;
}
function adjustment(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'adjustment',
    branchId: branch,
    documentDate: '2026-11-05',
    description: 'Ajuste de mercancía',
    currency: 'VES',
    exchangeRate: '1',
    lines: [
      {
        productId: id,
        direction: 'entry',
        quantity: '10',
        unitCost: '5',
        discountPercent: '0',
        taxRate: '0',
      },
    ],
    idempotencyKey: randomUUID(),
    ...overrides,
  };
}
async function stock(id: string) {
  const r = await db.transaction(principal, (c) =>
    c.query(
      'SELECT quantity,average_cost_base FROM stock_balances WHERE branch_id=$1 AND product_id=$2',
      [branch, id],
    ),
  );
  return r.rows[0] ?? { quantity: '0', average_cost_base: null };
}
async function createAndConfirm(body: ReturnType<typeof adjustment>) {
  const created = await request('/goods/documents', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const result = await request('/goods/documents/' + created.body.id + '/confirm', {
    expectedVersion: created.body.version,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}
before(async () => {
  if (!process.env.TEST_ADMIN_DATABASE_URL || !process.env.TEST_DATABASE_URL)
    throw new Error('Dedicated PostgreSQL test URLs required');
  const control = new URL(process.env.TEST_ADMIN_DATABASE_URL),
    runtime = new URL(process.env.TEST_DATABASE_URL);
  if (!control.pathname.endsWith('_test') || control.host !== runtime.host)
    throw new Error('Use matching dedicated test URLs');
  control.pathname = '/postgres';
  admin = new Pool({ connectionString: control.toString() });
  await admin.query(`CREATE DATABASE ${dbName}`);
  control.pathname = '/' + dbName;
  runtime.pathname = '/' + dbName;
  owner = new Pool({ connectionString: control.toString() });
  await migrate(control.toString());
  await owner.query('INSERT INTO tenants(id,name,rif) VALUES($1,$2,$3),($4,$5,$6)', [
    tenant,
    'Empresa Mercancía',
    'J100000001',
    foreignTenant,
    'Otra empresa',
    'J200000001',
  ]);
  const hashed = await hashPassword(password);
  await owner.query(
    'INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3),($6,$7,$3)',
    [
      user,
      'goods-admin@example.test',
      hashed,
      foreignUser,
      'foreign-admin@example.test',
      cashier,
      'goods-cashier@example.test',
    ],
  );
  await owner.query(
    "INSERT INTO tenant_memberships VALUES($1,$2,'admin'),($3,$4,'admin'),($1,$5,'cashier')",
    [tenant, user, foreignTenant, foreignUser, cashier],
  );
  await owner.query('INSERT INTO branches(tenant_id,id,name) VALUES($1,$2,$3),($4,$5,$6)', [
    tenant,
    branch,
    'Principal',
    foreignTenant,
    foreignBranch,
    'Privada',
  ]);
  await owner.query('INSERT INTO branch_memberships VALUES($1,$2,$3)', [tenant, branch, cashier]);
  p1 = await product('ART-ENTRADA');
  p2 = await product('ART-MIXTO');
  browserProduct = await product('BROWSER-GOODS');
  foreignSupplier = (
    await owner.query('INSERT INTO suppliers(tenant_id,rif,name) VALUES($1,$2,$3) RETURNING id', [
      foreignTenant,
      'J999999999',
      'Proveedor ajeno',
    ])
  ).rows[0].id;
  process.env.DATABASE_URL = runtime.toString();
  app = await createApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  db = app.get(Database);
  token = (await request('/auth/login', { email: 'goods-admin@example.test', password })).body
    .accessToken;
  foreignToken = (await request('/auth/login', { email: 'foreign-admin@example.test', password }))
    .body.accessToken;
  cashierToken = (await request('/auth/login', { email: 'goods-cashier@example.test', password }))
    .body.accessToken;
  const created = await request('/goods/suppliers', {
    rif: 'J-12345678-9',
    name: 'Mayorista de prueba',
  });
  assert.equal(created.status, 201);
  supplier = created.body.id;
});
after(async () => {
  if (app) await app.close();
  if (owner) await owner.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.end();
  }
});
test('guardar borradores es idempotente, admite edición y no mueve existencias', async () => {
  const body = adjustment(p1);
  const results = await Promise.all([
    request('/goods/documents', body),
    request('/goods/documents', body),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 201],
  );
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(results.filter((r) => r.body.replayed).length, 1);
  assert.equal(Number((await stock(p1)).quantity), 0);
  const { idempotencyKey, ...edit } = body;
  const updated = await request(
    '/goods/documents/' + results[0].body.id,
    { ...edit, lines: [{ ...edit.lines[0], quantity: '12' }], expectedVersion: 0 },
    'PATCH',
  );
  assert.equal(updated.status, 200);
  assert.equal(updated.body.version, 1);
  assert.equal(updated.body.status, 'draft');
  assert.equal(Number(updated.body.total), 60);
  firstDocument = updated.body;
  assert.equal(
    (
      await request(
        '/goods/documents/' + firstDocument.id,
        { ...edit, expectedVersion: 0 },
        'PATCH',
      )
    ).status,
    409,
  );
  assert.equal(
    (await request('/goods/documents', { ...body, description: 'Otro payload con la misma clave' }))
      .status,
    409,
  );
  assert.equal(Number((await stock(p1)).quantity), 0);
});
test('confirmaciones concurrentes aplican una sola entrada y protegen el documento confirmado', async () => {
  const path = '/goods/documents/' + firstDocument.id + '/confirm';
  const results = await Promise.all([
    request(path, { expectedVersion: 1 }),
    request(path, { expectedVersion: 1 }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 201],
  );
  assert.equal(results.filter((r) => r.body.replayed).length, 1);
  assert.equal(Number((await stock(p1)).quantity), 12);
  assert.equal(Number((await stock(p1)).average_cost_base), 5);
  assert.equal((await request(path, { expectedVersion: 999 })).body.replayed, true);
  const rows = await db.transaction(principal, (c) =>
    c.query('SELECT * FROM stock_movements WHERE document_id=$1', [firstDocument.id]),
  );
  assert.equal(rows.rowCount, 1);
  assert.ok(rows.rows[0].document_line_id);
  await assert.rejects(
    db.transaction(principal, (c) =>
      c.query("UPDATE inventory_documents SET description='Alterado' WHERE id=$1", [
        firstDocument.id,
      ]),
    ),
    (e: any) => e.code === '23514',
  );
  await assert.rejects(
    db.transaction(principal, (c) =>
      c.query('DELETE FROM inventory_document_lines WHERE document_id=$1', [firstDocument.id]),
    ),
    (e: any) => e.code === '23514',
  );
  const { idempotencyKey, ...data } = adjustment(p1);
  assert.equal(
    (
      await request(
        '/goods/documents/' + firstDocument.id,
        { ...data, expectedVersion: 2 },
        'PATCH',
      )
    ).status,
    409,
  );
});
test('un ajuste combina entradas y salidas de artículos distintos con valoración firmada', async () => {
  const d = await createAndConfirm(
    adjustment(p1, {
      lines: [
        { productId: p1, direction: 'exit', quantity: '3', unitCost: '5' },
        { productId: p2, direction: 'entry', quantity: '2', unitCost: '7' },
      ],
    }),
  );
  assert.equal(Number((await stock(p1)).quantity), 9);
  assert.equal(Number((await stock(p2)).quantity), 2);
  assert.equal(Number(d.total), -1);
  assert.equal(Number(d.inventory_value_base), -1);
  const ledger = await request(
    '/inventory/movements?branchId=' + branch + '&search=' + encodeURIComponent(d.display_number),
  );
  assert.equal(ledger.body.total, 2);
  assert.ok(ledger.body.items.every((m: any) => m.document_id === d.id));
});
test('una salida insuficiente revierte todos los renglones y deja el documento en borrador', async () => {
  const fresh = await product('SIN-RECEPCION');
  const created = await request(
    '/goods/documents',
    adjustment(p1, {
      lines: [
        { productId: fresh, direction: 'entry', quantity: '4', unitCost: '2' },
        { productId: p1, direction: 'exit', quantity: '100', unitCost: '5' },
      ],
    }),
  );
  const failed = await request('/goods/documents/' + created.body.id + '/confirm', {
    expectedVersion: 0,
  });
  assert.equal(failed.status, 409);
  assert.equal(Number((await stock(p1)).quantity), 9);
  assert.equal(Number((await stock(fresh)).quantity), 0);
  const d = await request('/goods/documents/' + created.body.id);
  assert.equal(d.body.status, 'draft');
  assert.equal(d.body.version, 0);
  assert.equal(
    (
      await db.transaction(principal, (c) =>
        c.query('SELECT id FROM stock_movements WHERE document_id=$1', [d.body.id]),
      )
    ).rowCount,
    0,
  );
});
test('factura con descuento e IVA recibe mercancía una vez y excluye IVA del costo promedio', async () => {
  const a = await product('COMPRA-IVA'),
    b = await product('COMPRA-EXENTO');
  const body = adjustment(a, {
    kind: 'purchase',
    supplierId: supplier,
    invoiceNumber: ' inv-001 ',
    controlNumber: '00-INV-001',
    paymentTerms: 'credit',
    dueDate: '2026-12-05',
    currency: 'USD',
    exchangeRate: '40',
    lines: [
      {
        productId: a,
        direction: 'entry',
        quantity: '2',
        unitCost: '10',
        discountPercent: '10',
        taxRate: '16',
      },
      {
        productId: b,
        direction: 'entry',
        quantity: '1',
        unitCost: '5',
        discountPercent: '0',
        taxRate: '0',
      },
    ],
  });
  const created = await request('/goods/documents', body);
  assert.equal(created.status, 201);
  assert.equal(Number(created.body.total), 25.88);
  assert.equal(Number(created.body.tax_total), 2.88);
  assert.equal(created.body.invoice_number, 'INV-001');
  assert.equal(Number((await stock(a)).quantity), 0);
  const confirmed = await request('/goods/documents/' + created.body.id + '/confirm', {
    expectedVersion: 0,
  });
  assert.equal(confirmed.status, 201);
  assert.equal(Number((await stock(a)).quantity), 2);
  assert.equal(Number((await stock(a)).average_cost_base), 360);
  assert.equal(Number((await stock(b)).average_cost_base), 200);
  assert.equal(Number(confirmed.body.inventory_value_base), 920);
  assert.equal(
    (
      await request('/goods/documents', {
        ...body,
        invoiceNumber: 'INV-001',
        idempotencyKey: randomUUID(),
      })
    ).status,
    409,
  );
  const foreign = await request('/goods/documents', {
    ...body,
    invoiceNumber: 'INV-002',
    supplierId: foreignSupplier,
    idempotencyKey: randomUUID(),
  });
  assert.equal(foreign.status, 404);
  assert.equal(
    (await request('/goods/suppliers', { rif: 'j123456789', name: 'Duplicado' })).status,
    409,
  );
  const runtimeProduct = await db.transaction(principal, (c) =>
    c.query('SELECT price_usd FROM products WHERE id=$1', [a]),
  );
  assert.equal(Number(runtimeProduct.rows[0].price_usd), 100);
});
test('el promedio ponderado se conserva en salidas y no inventa costos históricos desconocidos', async () => {
  const a = await product('PROMEDIO');
  await createAndConfirm(
    adjustment(a, { lines: [{ productId: a, direction: 'entry', quantity: '10', unitCost: '2' }] }),
  );
  await createAndConfirm(
    adjustment(a, { lines: [{ productId: a, direction: 'entry', quantity: '10', unitCost: '4' }] }),
  );
  assert.equal(Number((await stock(a)).average_cost_base), 3);
  const out = await createAndConfirm(
    adjustment(a, { lines: [{ productId: a, direction: 'exit', quantity: '5', unitCost: '999' }] }),
  );
  assert.equal(Number(out.lines[0].applied_cost_base), 3);
  assert.equal(Number(out.inventory_value_base), -15);
  const legacy = await request('/inventory/adjustments', {
    branchId: branch,
    productId: a,
    delta: '1',
    reason: 'Entrada antigua sin costo',
    idempotencyKey: randomUUID(),
  });
  assert.equal(legacy.status, 201);
  assert.equal((await stock(a)).average_cost_base, null);
  await createAndConfirm(
    adjustment(a, { lines: [{ productId: a, direction: 'entry', quantity: '1', unitCost: '10' }] }),
  );
  assert.equal((await stock(a)).average_cost_base, null);
});
test('dos salidas distintas compiten por la última unidad sin generar stock negativo', async () => {
  const a = await product('ULTIMA-UNIDAD');
  await createAndConfirm(
    adjustment(a, { lines: [{ productId: a, direction: 'entry', quantity: '1', unitCost: '1' }] }),
  );
  const docs = await Promise.all(
    [1, 2].map(() =>
      request(
        '/goods/documents',
        adjustment(a, {
          lines: [{ productId: a, direction: 'exit', quantity: '1', unitCost: '1' }],
        }),
      ),
    ),
  );
  const confirmed = await Promise.all(
    docs.map((d) => request('/goods/documents/' + d.body.id + '/confirm', { expectedVersion: 0 })),
  );
  assert.deepEqual(confirmed.map((r) => r.status).sort(), [201, 409]);
  assert.equal(Number((await stock(a)).quantity), 0);
});
test('valida fechas, cantidades, renglones, moneda y datos obligatorios de compra', async () => {
  const invalid = [
    adjustment(p1, { documentDate: '2026-02-30' }),
    adjustment(p1, { exchangeRate: '2' }),
    adjustment(p1, {
      lines: [{ productId: p1, direction: 'entry', quantity: '0', unitCost: '1' }],
    }),
    adjustment(p1, {
      lines: [{ productId: p1, direction: 'entry', quantity: '1', unitCost: '-1' }],
    }),
    adjustment(p1, {
      lines: [{ productId: p1, direction: 'entry', quantity: '1', unitCost: '1', taxRate: '16' }],
    }),
    adjustment(p1, {
      lines: [
        { productId: p1, direction: 'entry', quantity: '1', unitCost: '1' },
        { productId: p1, direction: 'exit', quantity: '1', unitCost: '1' },
      ],
    }),
    adjustment(p1, { kind: 'purchase' }),
    adjustment(p1, {
      kind: 'purchase',
      supplierId: supplier,
      invoiceNumber: 'INVALID-1',
      controlNumber: 'X',
      paymentTerms: 'credit',
      dueDate: '2026-01-01',
    }),
  ];
  for (const body of invalid) assert.equal((await request('/goods/documents', body)).status, 400);
});
test('documentos, proveedores y renglones mantienen RLS y permisos de administrador', async () => {
  const other = await product('ART-AJENO', foreignTenant);
  const foreign = await request(
    '/goods/documents',
    adjustment(other, { branchId: foreignBranch }),
    undefined,
    foreignToken,
    foreignTenant,
  );
  assert.equal(foreign.status, 201);
  assert.equal((await request('/goods/documents/' + foreign.body.id)).status, 404);
  assert.equal((await request('/goods/documents', adjustment(other))).status, 400);
  assert.equal(
    (await request('/goods/documents', adjustment(p1, { branchId: foreignBranch }))).status,
    404,
  );
  assert.equal(
    (await request('/goods/documents', adjustment(p1), undefined, cashierToken)).status,
    403,
  );
  assert.equal((await request('/goods/suppliers', undefined, 'GET', cashierToken)).status, 403);
  const lines = await db.transaction(principal, (c) =>
    c.query('SELECT id FROM inventory_document_lines WHERE document_id=$1', [foreign.body.id]),
  );
  assert.equal(lines.rowCount, 0);
  await assert.rejects(
    db.transaction(principal, (c) =>
      c.query('INSERT INTO suppliers(tenant_id,rif,name) VALUES($1,$2,$3)', [
        foreignTenant,
        'J111111111',
        'Intruso',
      ]),
    ),
    (e: any) => e.code === '42501',
  );
});

function reviewedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    branchId: branch,
    idempotencyKey: randomUUID(),
    reviewed: true,
    sourceKind: 'image',
    imageHash: 'a'.repeat(64),
    rawText: 'Factura de prueba',
    supplierName: 'Proveedor Imagen',
    supplierRif: 'J777777777',
    invoiceNumber: 'OCR-001',
    controlNumber: '00-OCR-001',
    documentDate: '2026-09-27',
    currency: 'VES',
    exchangeRate: '1',
    declaredTotal: '20',
    paymentTerms: 'cash',
    dueDate: null,
    lines: [
      {
        name: 'MEDICAMENTO OCR 500MG X 10',
        quantity: '2',
        unitCost: '10',
        discountPercent: '0',
        taxRate: '0',
      },
    ],
    ...overrides,
  };
}
test('catálogo de los 18 artículos: carga concurrente idempotente, sin stock ni precio inventado', async () => {
  const loaded = await Promise.all([
    request('/goods/invoice-images/example/catalog', {}),
    request('/goods/invoice-images/example/catalog', {}),
  ]);
  assert.ok(
    loaded.every((r) => r.status === 201),
    JSON.stringify(loaded),
  );
  assert.equal(
    loaded.reduce((sum, r) => sum + r.body.created, 0),
    18,
  );
  const products = await db.transaction(principal, (c) =>
    c.query("SELECT * FROM products WHERE catalog_source_key LIKE 'nicopharma-example-%'"),
  );
  assert.equal(products.rowCount, 18);
  assert.ok(products.rows.every((p) => p.price_pending && Number(p.price_usd) === 0 && !p.barcode));
  assert.equal(Number((await stock(products.rows[0].id)).quantity), 0);
  assert.equal(
    (await request('/goods/invoice-images/example/catalog', {}, undefined, cashierToken)).status,
    403,
  );
  const foreign = await request(
    '/goods/invoice-images/example/catalog',
    {},
    undefined,
    foreignToken,
    foreignTenant,
  );
  assert.equal(foreign.body.created, 18);
  const renamed = products.rows[0];
  await owner.query("UPDATE products SET name='Nombre revisado',active=false WHERE id=$1", [
    renamed.id,
  ]);
  const repeat = await request('/goods/invoice-images/example/catalog', {});
  assert.equal(repeat.body.created, 0);
});
test('importar crea proveedor y factura atómicamente, conserva precios y recibe solo al confirmar', async () => {
  const input = reviewedInvoice();
  const responses = await Promise.all([
    request('/goods/invoice-images/apply', input),
    request('/goods/invoice-images/apply', input),
  ]);
  assert.ok(
    responses.every((r) => r.status === 201),
    JSON.stringify(responses),
  );
  assert.equal(responses[0].body.id, responses[1].body.id);
  const d = responses[0].body;
  assert.equal(d.status, 'draft');
  assert.equal(d.source_kind, 'image');
  const id = d.lines[0].product_id;
  assert.equal(Number((await stock(id)).quantity), 0);
  const pending = await db.transaction(principal, (c) =>
    c.query('SELECT * FROM products WHERE id=$1', [id]),
  );
  assert.equal(pending.rows[0].price_pending, true);
  assert.equal(Number(pending.rows[0].price_usd), 0);
  const quoted = await request('/quotes/preview', {
    rate: '40',
    lines: [{ productId: id, quantity: '1' }],
    payments: [],
  });
  assert.equal(quoted.status, 400);
  assert.match(JSON.stringify(quoted.body), /precio de venta/);
  const confirmed = await request('/goods/documents/' + d.id + '/confirm', { expectedVersion: 0 });
  assert.equal(confirmed.status, 201);
  assert.equal(Number((await stock(id)).quantity), 2);
  const corrected = await request(
    '/products/' + id,
    {
      name: 'MEDICAMENTO OCR 500MG X 10 CORREGIDO',
      barcode: null,
      priceUsd: '0',
      taxCategory: 'exempt',
      expectedVersion: 0,
    },
    'PATCH',
  );
  assert.equal(corrected.status, 200);
  assert.equal(corrected.body.price_pending, true);
  const priced = await request(
    '/products/' + id,
    {
      name: corrected.body.name,
      barcode: null,
      priceUsd: '2',
      taxCategory: 'exempt',
      expectedVersion: 1,
    },
    'PATCH',
  );
  assert.equal(priced.status, 200);
  assert.equal(priced.body.price_pending, false);
  assert.equal(
    (
      await request('/quotes/preview', {
        rate: '40',
        lines: [{ productId: id, quantity: '1' }],
        payments: [],
      })
    ).status,
    201,
  );

  const duplicate = await request(
    '/goods/invoice-images/apply',
    reviewedInvoice({
      invoiceNumber: 'OCR-002',
      supplierRif: 'J888888888',
      lines: [
        {
          name: 'NO DEBE QUEDAR CREADO',
          quantity: '2',
          unitCost: '10',
          discountPercent: '0',
          taxRate: '0',
        },
      ],
    }),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await owner.query("SELECT id FROM products WHERE name='NO DEBE QUEDAR CREADO'")).rowCount,
    0,
  );
  assert.equal(
    (
      await owner.query("SELECT id FROM suppliers WHERE tenant_id=$1 AND rif='J888888888'", [
        tenant,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await request('/goods/documents/' + d.id, undefined, 'GET', foreignToken, foreignTenant))
      .status,
    404,
  );
  const existing = await product('CODIGO-REAL-OCR');
  const linked = await request(
    '/goods/invoice-images/apply',
    reviewedInvoice({
      imageHash: 'b'.repeat(64),
      invoiceNumber: 'OCR-003',
      lines: [
        {
          name: 'Descripción abreviada del proveedor',
          existingSku: 'CODIGO-REAL-OCR',
          quantity: '2',
          unitCost: '10',
          discountPercent: '0',
          taxRate: '0',
        },
      ],
    }),
  );
  assert.equal(linked.status, 201);
  assert.equal(linked.body.lines[0].product_id, existing);
  assert.equal(linked.body.createdProducts, 0);
  const price = await owner.query('SELECT price_usd,price_pending FROM products WHERE id=$1', [
    existing,
  ]);
  assert.equal(Number(price.rows[0].price_usd), 100);
  assert.equal(price.rows[0].price_pending, false);
});
test('exige revisión, cuadratura y permisos; rechaza la discrepancia del ejemplo antes de crear maestros', async () => {
  for (const change of [
    { reviewed: false },
    { declaredTotal: '19' },
    { imageHash: null },
    { lines: [{ name: 'Cantidad inválida', quantity: '0', unitCost: '10', taxRate: '0' }] },
  ])
    assert.equal(
      (await request('/goods/invoice-images/apply', reviewedInvoice(change))).status,
      400,
    );
  const example = await request('/goods/invoice-images/example');
  assert.equal(example.body.reading.lines.length, 18);
  const input = reviewedInvoice({
    supplierName: invoiceExample.supplierName,
    supplierRif: invoiceExample.supplierRif,
    invoiceNumber: invoiceExample.invoiceNumber,
    controlNumber: invoiceExample.controlNumber,
    declaredTotal: invoiceExample.declaredTotal,
    branchId: branch,
    sourceKind: 'example',
    imageHash: null,
    lines: invoiceExample.lines.map(({ name, quantity, unitCost, taxRate, sourceKey }) => ({
      name,
      quantity,
      unitCost,
      taxRate,
      sourceKey,
    })),
  });
  const mismatch = await request('/goods/invoice-images/apply', input);
  assert.equal(mismatch.status, 400);
  assert.match(JSON.stringify(mismatch.body), /203381/);
  assert.equal(
    (await request('/goods/invoice-images/apply', reviewedInvoice(), undefined, cashierToken))
      .status,
    403,
  );
});

if (process.env.RUN_BROWSER === '1')
  test('navegador: factura de compra y ajuste de salida con documento e historial', async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        locale: 'es-VE',
        timezoneId: 'America/Caracas',
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => d.accept());
      await page.goto(base.replace(/\/api$/, ''));
      await page.getByLabel('Correo electrónico').fill('goods-admin@example.test');
      await page.getByLabel('Contraseña', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
      await page.getByRole('heading', { name: 'Resumen de operaciones' }).waitFor();
      await page.getByRole('button', { name: 'Facturas de compra', exact: true }).click();
      await page.getByRole('button', { name: 'Nueva factura de compra', exact: true }).click();
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Descripción', { exact: true })
        .fill('Compra navegador proveedor');
      await page.getByRole('button', { name: 'Nuevo proveedor', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('RIF del proveedor').fill('J-44444444-4');
      await dialog.getByLabel('Razón social del proveedor').fill('Mayorista Navegador');
      await dialog.getByRole('button', { name: 'Registrar proveedor' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('N.º factura del proveedor')
        .fill('BROWSER-2026');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('N.º control', { exact: true })
        .fill('00-BROWSER');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Moneda', { exact: true })
        .selectOption('USD');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Tasa Bs / USD', { exact: true })
        .fill('40');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Buscar artículo para documento')
        .fill('BROWSER-GOODS');
      await page.getByRole('button', { name: /BROWSER-GOODS · BROWSER-GOODS/ }).click();
      await page.locator('.goods-workspace:visible').getByLabel('Cantidad del renglón 1').fill('5');
      await page.locator('.goods-workspace:visible').getByLabel('Costo del renglón 1').fill('12');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Descuento del renglón 1')
        .fill('5');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('IVA del renglón 1')
        .selectOption('16');
      await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Borrador guardado' }).waitFor();
      assert.equal(Number((await stock(browserProduct)).quantity), 0);
      await page.getByRole('button', { name: 'Confirmar y recibir', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Documento confirmado' }).waitFor();
      assert.equal(Number((await stock(browserProduct)).quantity), 5);
      assert.equal(Number((await stock(browserProduct)).average_cost_base), 456);
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: process.env.SCREENSHOT_DIR + '/factura-compra.png',
          fullPage: true,
        });
      await page.getByRole('button', { name: 'Ajustes de entrada y salida', exact: true }).click();
      await page.getByRole('button', { name: 'Nuevo ajuste', exact: true }).click();
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Descripción', { exact: true })
        .fill('Salida navegador mercancía');
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Buscar artículo para documento')
        .fill('BROWSER-GOODS');
      await page.getByRole('button', { name: /BROWSER-GOODS · BROWSER-GOODS/ }).click();
      await page
        .locator('.goods-workspace:visible')
        .getByLabel('Tipo del renglón 1')
        .selectOption('exit');
      await page.locator('.goods-workspace:visible').getByLabel('Cantidad del renglón 1').fill('2');
      await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Borrador guardado' }).waitFor();
      await page.getByRole('button', { name: 'Confirmar ajuste', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Documento confirmado' }).waitFor();
      assert.equal(Number((await stock(browserProduct)).quantity), 3);
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: process.env.SCREENSHOT_DIR + '/ajuste-salida.png',
          fullPage: true,
        });
      await page.getByRole('tab', { name: 'Lista', exact: true }).click();
      await page
        .getByRole('row')
        .filter({ hasText: 'Salida navegador mercancía' })
        .getByRole('button', { name: 'Abrir' })
        .click();
      assert.equal(
        await page
          .locator('.goods-workspace:visible')
          .getByLabel('Cantidad del renglón 1')
          .isDisabled(),
        true,
      );
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        JSON.stringify(
          await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                'dialog,dialog > *,dialog .dialog-footer,dialog .invoice-review-layout,dialog .table-scroll',
              ),
            ].map((e) => ({
              name: e.className,
              width: e.getBoundingClientRect().width,
              x: e.getBoundingClientRect().x,
            })),
          ),
        ),
      );
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: process.env.SCREENSHOT_DIR + '/ajuste-movil.png',
          fullPage: true,
        });
      await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Salida navegador mercancía' }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        JSON.stringify(
          await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                'dialog,dialog > *,dialog .dialog-footer,dialog .invoice-review-layout,dialog .table-scroll',
              ),
            ].map((e) => ({
              name: e.className,
              width: e.getBoundingClientRect().width,
              x: e.getBoundingClientRect().x,
            })),
          ),
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });

if (process.env.RUN_BROWSER === '1')
  test('navegador: sube una imagen, revisa OCR y crea factura sin recibir stock', async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        locale: 'es-VE',
        timezoneId: 'America/Caracas',
      });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base.replace(/\/api$/, ''));
      await page.getByLabel('Correo electrónico').fill('goods-admin@example.test');
      await page.getByLabel('Contraseña', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
      await page.getByRole('heading', { name: 'Resumen de operaciones' }).waitFor();
      await page.getByRole('button', { name: 'Facturas de compra', exact: true }).click();
      await page.getByRole('button', { name: 'Importar imagen de factura' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Imagen de factura').setInputFiles({
        name: 'factura-prueba.png',
        mimeType: 'image/png',
        buffer: await invoiceImage(),
      });
      await dialog.getByRole('button', { name: 'Leer imagen y preparar factura' }).click();
      await dialog.getByLabel('Razón social del proveedor').waitFor({ timeout: 30000 });
      await dialog.locator('.invoice-preview img').evaluate(
        (img: HTMLImageElement) =>
          new Promise<void>((resolve, reject) => {
            if (img.complete) {
              img.naturalWidth ? resolve() : reject(new Error('Invoice preview unavailable'));
            } else {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error('Invoice preview unavailable'));
            }
          }),
      );
      assert.ok(
        (await dialog.getByLabel('Descripción importada 1').inputValue()).includes('ACETAMINOF'),
      );
      // The reviewer confirms all legally significant fields, including any uncertain OCR.
      await dialog.getByLabel('Razón social del proveedor').fill('Proveedor OCR Navegador');
      await dialog.getByLabel('RIF del proveedor').fill('J-50544767-0');
      await dialog.getByLabel('Número de factura', { exact: true }).fill('BROWSER-OCR-144');
      await dialog.getByLabel('Número de control', { exact: true }).fill('00-001864');
      await dialog.getByLabel('Fecha de factura').fill('2026-09-27');
      await dialog.getByLabel('Total impreso en la factura').fill('1949.70');
      await dialog.getByLabel('Cantidad importada 1').fill('10');
      await dialog.getByLabel('Costo importado 1').fill('194.97');
      await dialog.getByLabel('IVA importado 1').selectOption('0');
      const submit = dialog.getByRole('button', { name: 'Crear artículos y factura en borrador' });
      assert.equal(await submit.isDisabled(), true);
      await dialog.getByRole('checkbox').check();
      assert.equal(await submit.isEnabled(), true);
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({
          path: process.env.SCREENSHOT_DIR + '/importacion-imagen.png',
          fullPage: true,
        });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        JSON.stringify(
          await page.evaluate(() =>
            [
              ...document.querySelectorAll(
                'dialog,dialog > *,dialog .dialog-footer,dialog .invoice-review-layout,dialog .table-scroll',
              ),
            ].map((e) => ({
              name: e.className,
              width: e.getBoundingClientRect().width,
              x: e.getBoundingClientRect().x,
            })),
          ),
        ),
      );
      await page.setViewportSize({ width: 1440, height: 1000 });
      await submit.click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByRole('status').filter({ hasText: 'Factura importada en borrador' }).waitFor();
      const doc = (
        await request(
          '/goods/documents?branchId=' + branch + '&kind=purchase&search=BROWSER-OCR-144',
        )
      ).body.items[0];
      assert.equal(doc.status, 'draft');
      const full = await request('/goods/documents/' + doc.id);
      assert.equal(Number((await stock(full.body.lines[0].product_id)).quantity), 0);
      await page.getByRole('button', { name: 'Importar imagen de factura' }).click();
      await dialog.getByRole('button', { name: 'Revisar factura de ejemplo' }).click();
      await dialog.getByLabel('Descripción importada 18').waitFor();
      assert.equal(
        await dialog
          .getByRole('button', { name: 'Crear artículos y factura en borrador' })
          .isDisabled(),
        true,
      );
      assert.match(await dialog.innerText(), /no coincide/);
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
