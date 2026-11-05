import sharp from 'sharp';
/** Synthetic invoice: tests the local OCR engine, never represents the user's photograph. */
export async function invoiceImage() {
  const lines = [
    ['DROGUERIA PRUEBA C.A.', 70],
    ['RIF J-50544767-0', 125],
    ['FACTURA N° 144', 240],
    ['N° CONTROL 00-001864', 295],
    ['FECHA: 27/09/2026', 350],
    ['CANTIDAD   DESCRIPCION                     PRECIO    TOTAL', 440],
    ['10,00 ACETAMINOFEN 500MG X10 TAB 194,97 1949,70', 510],
    ['TOTAL EXENTO 1949,70', 650],
    ['TOTAL 1949,70', 710],
  ];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1000"><rect width="100%" height="100%" fill="white"/>' +
    lines
      .map(
        ([s, y]) =>
          `<text x="45" y="${y}" font-family="DejaVu Sans" font-size="32" fill="black">${s}</text>`,
      )
      .join('') +
    '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Manual transcription of visible fields; the generated test image is not the user's photograph. */
export const deliveryRows = [
  [
    '02-09',
    'CATETER INTRAVENOSO 24G CJA X 50 UND (E)',
    '20250327',
    '26/03/2030',
    'UND',
    '2.000',
    '0.3000',
    '600.00',
  ],
  [
    '02-16',
    'SUTURA VICRYL #0 75CM AGUJA 1/2 CICLO REF 340',
    '260617',
    '29/06/2031',
    'UND',
    '120',
    '1.3000',
    '156.00',
  ],
  [
    '02-17',
    'SUTURA VICRYL #1 75CM AGUJA 1/2 CICLO REF 341',
    '260617',
    '29/06/2031',
    'UND',
    '180',
    '1.3000',
    '234.00',
  ],
  ['02-22', 'GASA ESTERIL 4 X 4', '202606', '29/06/2031', 'UND', '20.000', '0.0900', '1,800.00'],
  [
    '02-33',
    'GUANTE DE NITRILO NEGRO TALLA M',
    '251211027',
    '09/01/2031',
    'UND',
    '4.000',
    '0.0500',
    '200.00',
  ],
  [
    '02-52',
    'SUTURA CROMICO #1 90CM REF 915',
    '260617',
    '29/06/2031',
    'UND',
    '120',
    '0.9000',
    '108.00',
  ],
];
export const deliveryText = [
  'VIPSalud',
  'J-50270625-9',
  'Nota Entrega: 0000-1197',
  'Fecha de Emision: 03/11/2026',
  'Fecha de Vencimiento: 10/11/2026',
  'Razon Social: DROGUERIA NICO PHARMA C.A.',
  'RIF J505447670',
  'Condiciones de Pago: CREDITO a 7 Dias',
  'Codigo Nombre del articulo Lote F-Vence Und Cant Precio Unit Total neto',
  ...deliveryRows.map((r) => r.join(' ')),
  'Total Unidades: 26,420',
  'SUB TOTAL: 3,098.00',
  'TOTAL IVA 16%: 0.00',
  'DESCUENTO: 0.00',
  'TOTAL GENERAL: 3,098.00',
  'ESTA NOTA DE ENTREGA ESTA EXPRESADA EN DOLARES AMERICANOS',
  'LOS PAGOS EN MONEDA NACIONAL SE RIGEN POR LA TASA DEL BCV EN SU PAGINA WEB CORRESPONDIENTE AL DIA DE PAGO',
  'SIN DERECHO A CREDITO FISCAL',
].join('\n');
export async function deliveryImage(variant: 'standard' | 'reordered' = 'standard') {
  const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  const text = (s: string, x: number, y: number, size = 23) =>
    `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${size}" fill="black">${esc(s)}</text>`;
  const xs = [45, 135, 800, 945, 1130, 1235, 1375, 1530];
  const headers = [
    'Codigo',
    'Nombre del articulo',
    'Lote',
    'F-Vence',
    'Und',
    'Cant',
    'Precio Unit',
    'Total neto',
  ];
  const order = variant === 'reordered' ? [1, 0, 5, 4, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7];
  const reorderedX = [45, 670, 850, 1000, 1120, 1420];
  let svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1720" height="1400"><rect width="100%" height="100%" fill="white"/>';
  svg +=
    text('VIPSalud', 45, 75, 48) +
    text('J-50270625-9', 45, 120, 25) +
    text('Nota Entrega: 0000-1197', 1050, 100, 30) +
    text('Fecha de Emision: 03/11/2026', 1050, 150) +
    text('Fecha de Vencimiento: 10/11/2026', 1050, 190);
  svg +=
    text('Razon Social: DROGUERIA NICO PHARMA C.A.', 45, 260) +
    text('RIF J505447670', 45, 305) +
    text('Condiciones de Pago: CREDITO a 7 Dias', 1000, 305);
  for (let i = 0; i < order.length; i++)
    svg += text(headers[order[i]!]!, variant === 'reordered' ? reorderedX[i]! : xs[i]!, 440, 22);
  for (let row = 0; row < deliveryRows.length; row++)
    for (let i = 0; i < order.length; i++)
      svg += text(
        deliveryRows[row]![order[i]!]!,
        variant === 'reordered' ? reorderedX[i]! : xs[i]!,
        500 + row * 44,
        22,
      );
  svg +=
    text('Total Unidades: 26,420', 45, 920) +
    text('ESTA NOTA DE ENTREGA ESTA EXPRESADA EN DOLARES AMERICANOS', 45, 1100, 20) +
    text('LOS PAGOS EN MONEDA NACIONAL SE RIGEN POR LA TASA DEL BCV', 45, 1140, 20) +
    text('SIN DERECHO A CREDITO FISCAL', 45, 1300, 25);
  svg +=
    text('SUB TOTAL: 3,098.00', 1300, 1080) +
    text('TOTAL IVA 16%: 0.00', 1300, 1130) +
    text('DESCUENTO: 0.00', 1300, 1180) +
    text('TOTAL GENERAL: 3,098.00', 1300, 1230);
  svg += '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
}
