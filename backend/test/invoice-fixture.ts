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
