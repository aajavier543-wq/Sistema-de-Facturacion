import { BadRequestException } from '@nestjs/common';
import { runInvoiceOcr } from '../src/invoice-ocr-engine';
import type { OcrOptions } from '../src/ocr-options';
let started = false;
process.on('disconnect', () => process.exit(0));
process.on('message', async (message: { type?: string; buffer?: Buffer; options?: OcrOptions }) => {
  if (started || message.type !== 'read' || !Buffer.isBuffer(message.buffer) || !message.options)
    return;
  started = true;
  try {
    const result = await runInvoiceOcr(message.buffer, message.options);
    if (process.connected) process.send!({ type: 'result', result }, () => process.exit(0));
    else process.exit(0);
  } catch (error) {
    // No image text, filenames, stacks or library messages cross the error channel.
    if (process.connected)
      process.send!(
        {
          type: 'error',
          code: error instanceof BadRequestException ? 'OCR_INVALID_IMAGE' : 'OCR_ENGINE_FAILED',
        },
        () => process.exit(1),
      );
    else process.exit(1);
  }
});
