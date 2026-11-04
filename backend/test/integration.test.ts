import 'reflect-metadata';
import 'dotenv/config';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { INestApplication } from '@nestjs/common';
import { createApplication } from '../src/create-app';
import { chromium } from 'playwright-core';
import { Database, Principal } from '../src/database';
import { hashPassword } from '../src/security';
import { migrate } from '../scripts/migrate';

let admin: Pool, owner: Pool, app: INestApplication, db: Database;
let base: string, token: string, cashierToken: string;
const name = `erp_test_${randomBytes(6).toString('hex')}`;
const a = randomUUID(),
  b = randomUUID(),
  user = randomUUID(),
  cashier = randomUUID();
const branch = randomUUID(),
  otherBranch = randomUUID(),
  foreignBranch = randomUUID();
const product = randomUUID(),
  foreignProduct = randomUUID();
const password = randomBytes(20).toString('hex');
const principal: Principal = { tenantId: a, userId: user, role: 'admin' };
async function request(
  path: string,
  options: { method?: string; body?: unknown; tenant?: string; token?: string } = {},
) {
  const response = await fetch(base + path, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': options.tenant ?? a,
      authorization: `Bearer ${options.token ?? token}`,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
before(async () => {
  // Never migrate/truncate an existing database. Every run creates an isolated DB.
  if (!process.env.TEST_ADMIN_DATABASE_URL || !process.env.TEST_DATABASE_URL)
    throw new Error(
      'Integration tests require TEST_ADMIN_DATABASE_URL and TEST_DATABASE_URL; no tests silently skipped',
    );
  const adminUrl = new URL(process.env.TEST_ADMIN_DATABASE_URL);
  const runtimeUrl = new URL(process.env.TEST_DATABASE_URL);
  if (!adminUrl.pathname.endsWith('_test') || adminUrl.host !== runtimeUrl.host)
    throw new Error('Use matching dedicated *_test database URLs');
  const controlUrl = new URL(adminUrl);
  controlUrl.pathname = '/postgres';
  admin = new Pool({ connectionString: controlUrl.toString() });
  await admin.query(`CREATE DATABASE ${name}`);
  adminUrl.pathname = '/' + name;
  runtimeUrl.pathname = '/' + name;
  owner = new Pool({ connectionString: adminUrl.toString() });
  await migrate(adminUrl.toString());
  await migrate(adminUrl.toString()); // Repeatability of migrations.
  await owner.query('INSERT INTO tenants(id,name,rif) VALUES($1,$2,$3),($4,$5,$6)', [
    a,
    'Empresa A',
    'J000000001',
    b,
    'Empresa B',
    'J000000002',
  ]);
  const encoded = await hashPassword(password);
  await owner.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3),($4,$5,$3)', [
    user,
    'admin@example.test',
    encoded,
    cashier,
    'cashier@example.test',
  ]);
  await owner.query(`INSERT INTO tenant_memberships VALUES($1,$2,'admin'),($1,$3,'cashier')`, [
    a,
    user,
    cashier,
  ]);
  await owner.query(
    'INSERT INTO branches(tenant_id,id,name) VALUES($1,$2,$3),($1,$4,$5),($6,$7,$8)',
    [a, branch, 'Principal', otherBranch, 'Restringida', b, foreignBranch, 'Otra empresa'],
  );
  await owner.query('INSERT INTO branch_memberships VALUES($1,$2,$3)', [a, branch, cashier]);
  await owner.query(
    `INSERT INTO products(tenant_id,id,sku,name,price_usd,tax_category)
    VALUES($1,$2,'SKU-A','Producto A',100,'exempt'),($3,$4,'SKU-B','Producto B',10,'general')`,
    [a, product, b, foreignProduct],
  );
  process.env.DATABASE_URL = runtimeUrl.toString();
  app = await createApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api';
  db = app.get(Database);
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: 'admin@example.test', password },
  });
  assert.equal(login.status, 201);
  token = login.body.accessToken;
  const cashLogin = await request('/auth/login', {
    method: 'POST',
    body: { email: 'cashier@example.test', password },
  });
  assert.equal(cashLogin.status, 201);
  cashierToken = cashLogin.body.accessToken;
});
after(async () => {
  if (app) {
    await app.close();
    assert.equal(db.pool.ended, true, 'Application shutdown must close its PostgreSQL pool');
  }
  if (owner) await owner.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  }
});
test('health real y autenticación: no acepta token inventado ni otro tenant', async () => {
  assert.equal((await request('/health/ready')).status, 200);
  assert.equal((await request('/products', { token: 'invalid' })).status, 401);
  assert.equal((await request('/products', { tenant: b })).status, 401);
  assert.equal(
    (
      await request('/auth/login', {
        method: 'POST',
        body: { email: 'admin@example.test', password: 'wrong' },
      })
    ).status,
    401,
  );
});
test('catálogo y RLS aíslan empresas y limpian contexto del pool', async () => {
  const result = await request('/products');
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.map((p: any) => p.id),
    [product],
  );
  const cross = await db.transaction(principal, (c) =>
    c.query('SELECT id FROM products WHERE id=$1', [foreignProduct]),
  );
  assert.equal(cross.rowCount, 0);
  assert.equal((await db.pool.query('SELECT id FROM products')).rowCount, 0);
  await assert.rejects(
    db.transaction(principal, (c) =>
      c.query(
        `INSERT INTO products(tenant_id,sku,name,price_usd,tax_category)
    VALUES($1,'INTRUSO','No permitido',1,'exempt')`,
        [b],
      ),
    ),
    (e: any) => e.code === '42501',
  );
});
test('cajero solo ve su sucursal y no puede crear productos ni ajustar inventario', async () => {
  const result = await request('/branches', { token: cashierToken });
  assert.deepEqual(
    result.body.map((b: any) => b.id),
    [branch],
  );
  const denied = await request('/products', {
    token: cashierToken,
    method: 'POST',
    body: { sku: 'NO', name: 'No', priceUsd: '1', taxCategory: 'exempt' },
  });
  assert.equal(denied.status, 403);
  const rows = await db.transaction({ tenantId: a, userId: cashier, role: 'cashier' }, (c) =>
    c.query('SELECT id FROM branches WHERE id=$1', [otherBranch]),
  );
  assert.equal(rows.rowCount, 0);
});
test('ajuste atómico, auditoría, reintento idempotente y conflicto de payload', async () => {
  const payload = {
    branchId: branch,
    productId: product,
    delta: '1',
    reason: 'Existencia inicial',
    idempotencyKey: randomUUID(),
  };
  const results = await Promise.all([
    request('/inventory/adjustments', { method: 'POST', body: payload }),
    request('/inventory/adjustments', { method: 'POST', body: payload }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    [201, 201],
  );
  assert.equal(results.filter((r) => r.body.replayed).length, 1);
  assert.equal(results[0].body.movement.id, results[1].body.movement.id);
  const conflict = await request('/inventory/adjustments', {
    method: 'POST',
    body: { ...payload, delta: '2' },
  });
  assert.equal(conflict.status, 409);
  const events = await db.transaction(principal, (c) =>
    c.query("SELECT id FROM audit_events WHERE action='stock.adjust'"),
  );
  assert.equal(events.rowCount, 1);
});
test('dos retiros concurrentes sobre la última unidad: solo uno se confirma', async () => {
  const results = await Promise.all(
    [1, 2].map(() =>
      request('/inventory/adjustments', {
        method: 'POST',
        body: {
          branchId: branch,
          productId: product,
          delta: '-1',
          reason: 'Retiro concurrente',
          idempotencyKey: randomUUID(),
        },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const balance = await request(`/branches/${branch}/stock`);
  assert.equal(balance.body[0].quantity, '0.000000');
});
test('no permite referencias cruzadas, ajustes cero ni entradas numéricas ambiguas', async () => {
  assert.equal(
    (
      await request('/inventory/adjustments', {
        method: 'POST',
        body: {
          branchId: branch,
          productId: foreignProduct,
          delta: '1',
          reason: 'Referencia externa',
          idempotencyKey: randomUUID(),
        },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request('/inventory/adjustments', {
        method: 'POST',
        body: {
          branchId: branch,
          productId: product,
          delta: '0',
          reason: 'Ajuste inválido',
          idempotencyKey: randomUUID(),
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/products', {
        method: 'POST',
        body: { sku: 'BAD', name: 'Inválido', priceUsd: 0.1, taxCategory: 'exempt' },
      })
    ).status,
    400,
  );
});
test('cotización usa precios del servidor y calcula pagos mixtos como simulación', async () => {
  const result = await request('/quotes/preview', {
    method: 'POST',
    body: {
      rate: '40',
      lines: [{ productId: product, quantity: '1' }],
      payments: [
        { principalUsd: '40', eligibleForIgtf: false },
        { principalUsd: '60', eligibleForIgtf: true },
      ],
    },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.igtfTotalBase, '72.00');
  assert.equal(result.body.simulation, true);
  assert.equal(result.body.fiscalDocument, false);
});
test('panel y consultas paginadas respetan empresa y sucursal', async () => {
  const summary = await request('/dashboard?branchId=' + branch);
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body, { products: 1, with_stock: 0, without_stock: 1, branches: 2 });
  const stock = await request(`/inventory/stock?branchId=${branch}&limit=1`);
  assert.equal(stock.body.total, 1);
  assert.equal(stock.body.items[0].id, product);
  assert.equal(Number(stock.body.items[0].quantity), 0);
  assert.equal((await request('/dashboard?branchId=' + foreignBranch)).status, 404);
  assert.equal(
    (await request('/inventory/stock?branchId=' + otherBranch, { token: cashierToken })).status,
    404,
  );
  const cashierSummary = await request('/dashboard?branchId=' + branch, { token: cashierToken });
  assert.equal(cashierSummary.body.branches, 1);
});
test('historial refleja movimientos únicos y filtra sin exponer otra sucursal', async () => {
  const ledger = await request('/inventory/movements?branchId=' + branch);
  assert.equal(ledger.status, 200);
  assert.equal(ledger.body.total, 2);
  const filtered = await request('/inventory/movements?branchId=' + branch + '&search=concurrente');
  assert.equal(filtered.body.total, 1);
  assert.equal(Number(filtered.body.items[0].delta), -1);
  assert.equal(
    (await request('/inventory/movements?branchId=' + otherBranch, { token: cashierToken })).status,
    404,
  );
});
test('edición auditada detecta conflictos y el cotizador usa el precio actualizado', async () => {
  const body = {
    name: 'Producto A actualizado',
    barcode: null,
    priceUsd: '125',
    taxCategory: 'exempt',
    expectedVersion: 0,
  };
  const update = await request('/products/' + product, { method: 'PATCH', body });
  assert.equal(update.status, 200);
  assert.equal(update.body.version, 1);
  assert.equal((await request('/products/' + product, { method: 'PATCH', body })).status, 409);
  assert.equal(
    (await request('/products/' + product, { method: 'PATCH', body, token: cashierToken })).status,
    403,
  );
  assert.equal(
    (await request('/products/' + foreignProduct, { method: 'PATCH', body })).status,
    404,
  );
  const quote = await request('/quotes/preview', {
    method: 'POST',
    body: { rate: '40', lines: [{ productId: product, quantity: '1' }] },
  });
  assert.equal(quote.body.purchaseTotalBase, '5000.00');
  assert.equal(quote.body.lines[0].sku, 'SKU-A');
  assert.equal(quote.body.lines[0].name, 'Producto A actualizado');
  assert.equal(Number(quote.body.lines[0].priceUsd), 125);
  const audit = await db.transaction(principal, (c) =>
    c.query("SELECT details FROM audit_events WHERE action='product.update' AND entity_id=$1", [
      product,
    ]),
  );
  assert.equal(audit.rowCount, 1);
  assert.equal(Number(audit.rows[0].details.before.price_usd), 100);
});
if (process.env.RUN_BROWSER === '1')
  test('navegador: panel, artículos editables, movimientos, exportación, cotización y sucursales', async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(base.replace(/\/api$/, ''));
      await page.getByLabel('Correo electrónico').fill('admin@example.test');
      await page.getByLabel('Contraseña', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Ingresar al sistema' }).click();
      await page.getByRole('heading', { name: 'Resumen de operaciones' }).waitFor();
      await page.getByRole('button', { name: 'Artículos y existencias', exact: true }).click();
      await page.getByRole('button', { name: 'Nuevo artículo', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByLabel('Código / SKU').fill('BROWSER-1');
      await dialog.getByLabel('Descripción del artículo').fill('Producto navegador');
      await dialog.getByLabel('Precio USD sin IVA').fill('100');
      await dialog.getByLabel('IVA', { exact: true }).selectOption('exempt');
      await dialog.getByRole('button', { name: 'Crear artículo', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      let row = page.getByRole('row').filter({ hasText: 'BROWSER-1' });
      await row.click();
      await page.getByRole('button', { name: 'Editar ficha' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Descripción del artículo').fill('Producto navegador actualizado');
      await dialog.getByRole('button', { name: 'Guardar cambios' }).click();
      await dialog.waitFor({ state: 'hidden' });
      row = page.getByRole('row').filter({ hasText: 'BROWSER-1' });
      await row.click();
      await page.getByRole('button', { name: 'Ajustar existencia' }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Cantidad a sumar o restar').fill('3');
      await dialog.getByLabel('Motivo del ajuste').fill('Conteo inicial navegador');
      await dialog.getByRole('button', { name: 'Registrar ajuste' }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page
        .getByRole('row')
        .filter({ hasText: 'BROWSER-1' })
        .getByText('Disponible', { exact: true })
        .waitFor();
      const downloadEvent = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Exportar página' }).click();
      const download = await downloadEvent;
      assert.equal(download.suggestedFilename(), 'articulos-pagina.csv');
      const stream = await download.createReadStream();
      let csv = '';
      for await (const chunk of stream) csv += chunk.toString();
      assert.match(csv, /BROWSER-1/);
      assert.match(csv, /Producto navegador actualizado/);
      await page.getByRole('button', { name: 'Movimientos', exact: true }).click();
      await page.getByRole('row').filter({ hasText: 'Conteo inicial navegador' }).waitFor();
      await page.getByRole('button', { name: 'Artículos y existencias', exact: true }).click();
      await page.getByLabel('Tasa manual Bs por USD').fill('40');
      await page.getByRole('row').filter({ hasText: 'BROWSER-1' }).click();
      await page.getByRole('button', { name: 'Cotizar', exact: true }).click();
      await page.getByLabel('Cantidad de Producto navegador actualizado').waitFor();
      await page.getByLabel('Principal no gravado por IGTF').fill('40');
      await page.getByLabel('Principal elegible para IGTF').fill('60');
      await page.getByRole('button', { name: 'Calcular cotización', exact: true }).click();
      await page.locator('.totals').waitFor();
      assert.match(await page.locator('.totals').innerText(), /72,00/);
      assert.match(await page.locator('.totals').innerText(), /4\.072,00/);
      await page.getByRole('button', { name: 'Resumen de operaciones', exact: true }).click();
      await page.getByRole('button', { name: 'Cotizaciones', exact: true }).click();
      assert.equal(
        await page.getByLabel('Cantidad de Producto navegador actualizado').inputValue(),
        '1',
      );
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('.print-document').isVisible(), true);
      assert.match(await page.locator('.print-document').innerText(), /NO ES FACTURA FISCAL/);
      await page.emulateMedia({ media: 'screen' });
      if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({
          path: process.env.SCREENSHOT_DIR + '/cotizacion.png',
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      if (process.env.SCREENSHOT_DIR)
        await page.screenshot({ path: process.env.SCREENSHOT_DIR + '/movil.png', fullPage: true });
      await page.getByRole('button', { name: 'Sucursales', exact: true }).click();
      await page.getByRole('button', { name: 'Nueva sucursal', exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByLabel('Nombre de la sucursal').fill('Sucursal navegador');
      await dialog.getByRole('button', { name: 'Crear sucursal', exact: true }).click();
      await page.getByRole('heading', { name: 'Sucursal navegador', exact: true }).waitFor();
      page.on('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByRole('heading', { name: 'Bienvenido a tu empresa' }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
test('logout revoca la sesión de forma efectiva', async () => {
  assert.equal((await request('/auth/session', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/products')).status, 401);
});
