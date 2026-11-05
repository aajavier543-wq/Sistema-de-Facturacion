export {};
// Disposable process fixture. It deliberately models failures in initialization and native work.
const mode = process.argv[2];
if (mode === 'initialization') setInterval(() => {}, 1000);
else
  process.on('message', () => {
    if (mode === 'processing') {
      while (true) {
        /* an unresponsive OCR/native computation */
      }
    }
    if (mode === 'crash') {
      process.exit(7);
    }
    if (mode === 'error') {
      process.send?.({ type: 'error', code: 'OCR_ENGINE_FAILED' });
      setInterval(() => {}, 1000);
      return;
    }
    const result = {
      reading: {
        documentType: 'invoice',
        supplierName: 'Lifecycle fixture',
        supplierRif: 'J123456789',
        invoiceNumber: '1',
        controlNumber: '00-1',
        documentDate: '2026-11-05',
        dueDate: null,
        paymentTerms: 'cash',
        currency: 'VES',
        exchangeRate: '1',
        declaredTotal: '1',
        declaredQuantity: null,
        warnings: [],
        lines: [],
      },
      rawText: 'Lifecycle fixture',
      confidence: 100,
      imageHash: '1'.repeat(64),
      attempts: 1,
      engine: 'test-fixture',
    };
    process.send?.({ type: 'result', result }, () => {
      if (mode === 'success') process.exit(0);
    });
    if (mode === 'cleanup') setInterval(() => {}, 1000);
  });
