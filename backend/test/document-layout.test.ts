import { test } from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import sharp from 'sharp';
import { numberCandidates, reconcileRow } from '../src/document-numbers';
import { parseInvoiceText } from '../src/invoice-parser';
import { parseLayoutTable, type OcrWord } from '../src/document-layout';
import { InvoiceOcr, ocrOptionsSchema } from '../src/invoice-ocr';
import { deliveryText, deliveryImage } from './invoice-fixture';

test('resuelve miles, decimales de cuatro posiciones y ambigüedades mediante la aritmética del renglón', () => {
  assert.deepEqual(numberCandidates('2.000'), ['2', '2000']);
  assert.deepEqual(numberCandidates('1,800.00'), ['1800']);
  assert.deepEqual(reconcileRow('2.000', '0.3000', '600.00'), {
    quantity: '2000',
    unitCost: '0.3',
    printedTotal: '600',
    ambiguous: false,
  });
  assert.equal(reconcileRow('20.000', '0.0900', '1,800.00').quantity, '20000');
  assert.equal(reconcileRow('120', '1.3000', '156.00').unitCost, '1.3');
  const ambiguous = reconcileRow('1.000', '1.000', '1000.00');
  assert.equal(ambiguous.quantity, null);
  assert.equal(ambiguous.unitCost, null);
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(reconcileRow('1', '100', '104.40', '10', '16').ambiguous, false);
});
test('interpreta una nota de entrega con códigos, lotes y fechas sin confundir al receptor con el emisor', () => {
  const d = parseInvoiceText(deliveryText);
  assert.equal(d.documentType, 'delivery_note');
  assert.equal(d.invoiceNumber, '0000-1197');
  assert.equal(d.controlNumber, null);
  assert.equal(d.documentDate, '2026-11-03');
  assert.equal(d.dueDate, '2026-11-10');
  assert.equal(d.paymentTerms, 'credit');
  assert.equal(d.supplierName, 'VIPSalud');
  assert.equal(d.supplierRif, 'J502706259');
  assert.equal(d.currency, 'USD');
  assert.equal(d.exchangeRate, null);
  assert.equal(d.declaredTotal, '3098');
  assert.equal(d.lines.length, 6);
  assert.equal(d.declaredQuantity, '26420');
  assert.deepEqual(
    d.lines.map((l) => l.quantity),
    ['2000', '120', '180', '20000', '4000', '120'],
  );
  assert.equal(d.lines[0]!.sourceCode, '02-09');
  assert.equal(d.lines[0]!.lot, '20250327');
  assert.equal(d.lines[0]!.expiry, '26/03/2030');
  assert.ok(d.lines.every((l) => l.taxRate === null));
  assert.ok(d.warnings.some((w) => w.includes('IVA total cero')));
  assert.equal(
    d.lines.reduce((s, l) => s.plus(l.printedTotal!), new Decimal(0)).toFixed(2),
    '3098.00',
  );
});
function row(values: { text: string; x: number }[], y: number): OcrWord[] {
  return values.map((v) => ({
    text: v.text,
    x0: v.x,
    y0: y,
    x1: v.x + v.text.length * 8,
    y1: y + 20,
    confidence: 95,
  }));
}
test('asigna columnas por encabezados aunque cantidad, artículo, código y precio cambien de orden', () => {
  const headers = row(
    [
      { text: 'Descripcion', x: 10 },
      { text: 'Codigo', x: 420 },
      { text: 'Precio Unit', x: 540 },
      { text: 'Cantidad', x: 700 },
      { text: 'IVA', x: 840 },
      { text: 'Total', x: 950 },
    ],
    100,
  );
  const item = row(
    [
      { text: 'MEDICAMENTO', x: 10 },
      { text: '500MG', x: 115 },
      { text: 'REF-22', x: 420 },
      { text: '100.0000', x: 540 },
      { text: '2', x: 715 },
      { text: '16%', x: 840 },
      { text: '232.00', x: 950 },
    ],
    140,
  );
  const table = parseLayoutTable([...headers, ...item]);
  assert.equal(table.lines.length, 1);
  assert.equal(table.lines[0]!.name, 'MEDICAMENTO 500MG');
  assert.equal(table.lines[0]!.quantity, '2');
  assert.equal(table.lines[0]!.unitCost, '100');
  assert.equal(table.lines[0]!.taxRate, '16');
  assert.equal(table.lines[0]!.needsReview, false);
});
test('el pie de crédito fiscal no crea una condición de venta a crédito ni una exención inventada', () => {
  const d = parseInvoiceText(
    'PROVEEDOR PRUEBA C.A.\nRIF J123456789\nFACTURA 100\nFECHA: 05/11/2026\n1,00 PRODUCTO EJEMPLO 100,00 100,00\nTOTAL IVA 16%: 0,00\nTOTAL 100,00\nSIN DERECHO A CREDITO FISCAL',
  );
  assert.equal(d.paymentTerms, 'cash');
  assert.equal(d.lines[0]!.taxRate, null);
  assert.equal(parseInvoiceText('FACTURA 1\nFECHA: 31/02/2026').documentDate, null);
});
test('opciones de recorte y rotación se validan antes de procesar los archivos', () => {
  assert.equal(
    ocrOptionsSchema.safeParse({ rotation: 90, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } })
      .success,
    true,
  );
  for (const x of [
    { rotation: 45 },
    { crop: { x: 0.5, y: 0.1, width: 0.8, height: 0.8 } },
    { crop: { x: 0, y: 0, width: 0, height: 1 } },
    { url: 'https://example.test/image' },
  ])
    assert.equal(ocrOptionsSchema.safeParse(x).success, false);
});
test('OCR real reconoce dos distribuciones distintas de la misma tabla, sin plantilla de proveedor', async () => {
  for (const variant of ['standard', 'reordered'] as const) {
    const buffer = await deliveryImage(variant);
    const result = await new InvoiceOcr().recognize({
      buffer,
      size: buffer.length,
      mimetype: 'image/png',
    });
    assert.equal(result.reading.documentType, 'delivery_note');
    assert.equal(result.reading.supplierRif, 'J502706259');
    assert.equal(result.reading.invoiceNumber, '0000-1197');
    assert.equal(result.reading.currency, 'USD');
    assert.equal(result.reading.declaredTotal, '3098');
    assert.equal(result.reading.lines.length, 6);
    assert.deepEqual(
      result.reading.lines.map((l) => l.quantity),
      ['2000', '120', '180', '20000', '4000', '120'],
    );
  }
});
test('OCR real permite orientar y recortar una foto con fondo; la identidad corresponde al original', async () => {
  const original = await deliveryImage();
  const rotated = await sharp(original).rotate(90).png().toBuffer();
  const buffer = await sharp({
    create: { width: 1800, height: 2120, channels: 3, background: '#555555' },
  })
    .composite([{ input: rotated, left: 200, top: 200 }])
    .png()
    .toBuffer();
  // Crop coordinates apply after rotation, matching the preview in the browser.
  const oriented = await sharp(buffer).rotate(270).png().toBuffer();
  const m = await sharp(oriented).metadata();
  const result = await new InvoiceOcr().recognize(
    { buffer, size: buffer.length, mimetype: 'image/png' },
    {
      rotation: 270,
      crop: {
        x: 200 / m.width!,
        y: 200 / m.height!,
        width: 1720 / m.width!,
        height: 1400 / m.height!,
      },
      detailed: true,
    },
  );
  assert.equal(result.reading.lines.length, 6);
  assert.equal(result.reading.invoiceNumber, '0000-1197');
  assert.equal(result.attempts, 3);
});
