import { HttpException } from '@nestjs/common';

// Never return or log a provider body: it may echo keys, identifiers or document text.
export async function boundedGoogleJson(
  response: Response,
  maxBytes = 64 * 1024,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maxBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
export async function googleFailure(response: Response): Promise<HttpException> {
  const body = (await boundedGoogleJson(response)) as any;
  const error = body?.error;
  const message = typeof error?.message === 'string' ? error.message.slice(0, 16000) : '';
  const reasons = new Set<string>(
    Array.isArray(error?.details)
      ? error.details.flatMap((d: any) =>
          d?.['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' &&
          typeof d.reason === 'string'
            ? [d.reason]
            : [],
        )
      : [],
  );
  const has = (...values: string[]) => values.some((v) => reasons.has(v));
  const fail = (code: string, text: string, status = 503) =>
    new HttpException(
      {
        code,
        message: `${text} (Google HTTP ${response.status}; ${code}).`,
        providerStatus: response.status,
      },
      status,
    );
  if (has('API_KEY_LEAKED') || /(?:reported as|has been) leaked/i.test(message))
    return fail(
      'GEMINI_KEY_EXPOSED',
      'Google bloqueó la clave por exposición. Revócala, crea una nueva y actualiza GEMINI_API_KEY en Render',
    );
  if (
    has('API_KEY_INVALID', 'API_KEY_EXPIRED', 'CREDENTIALS_MISSING') ||
    /API key (?:not valid|is invalid|expired)|API_KEY_INVALID/i.test(message)
  )
    return fail(
      'GEMINI_INVALID_KEY',
      'Google rechazó la clave de API. Copia una clave válida de Google AI Studio en GEMINI_API_KEY y guarda los cambios en Render',
    );
  if (has('API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED'))
    return fail(
      'GEMINI_KEY_RESTRICTED',
      'Las restricciones de la clave impiden usarla desde Render. Revisa en Google Cloud las APIs permitidas y las restricciones de aplicación de esa clave',
    );
  if (has('SERVICE_DISABLED', 'API_DISABLED'))
    return fail(
      'GEMINI_API_DISABLED',
      'La API de Gemini no está habilitada en el proyecto de la clave. Revisa Generative Language API en Google Cloud',
    );
  if (/free tier.*(?:not available|unavailable)/i.test(message))
    return fail(
      'GEMINI_FREE_TIER_UNAVAILABLE',
      'Google indica que el cupo gratuito no está disponible para este proyecto o región. Revisa su disponibilidad en Google AI Studio; la aplicación no activó facturación',
    );
  if (
    /user location is not supported|location.*not supported.*API use|unsupported (?:country|region)/i.test(
      message,
    )
  )
    return fail(
      'GEMINI_REGION_UNAVAILABLE',
      'Google no permite usar esta API desde la ubicación de la solicitud. Revisa las regiones admitidas y la región del servidor Render',
    );
  if (has('BILLING_DISABLED', 'BILLING_NOT_ACTIVE', 'CONSUMER_SUSPENDED'))
    return fail(
      'GEMINI_PROJECT_UNAVAILABLE',
      'Google rechazó el estado del proyecto de la clave. Revisa en Google AI Studio su acceso y disponibilidad de cupo gratuito; la aplicación no cambió la facturación',
    );
  if (response.status === 429)
    return fail(
      'GEMINI_QUOTA',
      'Google limitó las solicitudes de este proyecto. Revisa su cuota disponible en Google AI Studio antes de reintentar',
      429,
    );
  if (response.status === 401 || response.status === 403)
    return fail(
      'GEMINI_AUTH',
      'La clave no tiene acceso a Gemini. Revisa el proyecto, sus permisos y las restricciones de la clave en Google AI Studio y Google Cloud',
    );
  if (
    response.status === 404 ||
    /not supported for generateContent|model.*(?:not found|not supported)/i.test(message)
  )
    return fail(
      'GEMINI_MODEL_UNAVAILABLE',
      'El modelo configurado no está disponible para esta cuenta. Revisa GEMINI_MODEL y usa Comprobar conexión',
    );
  if (response.status === 400) {
    if (
      /response.?schema|generation.?config|unknown name|invalid JSON payload|not supported|unsupported/i.test(
        message,
      )
    )
      return fail(
        'GEMINI_REQUEST_FORMAT',
        'Google rechazó el formato o los parámetros enviados al modelo. Se debe revisar la integración; cambiar la fotografía no corrige este rechazo',
      );
    return fail(
      'GEMINI_BAD_REQUEST',
      'Google rechazó la solicitud como inválida. Usa Comprobar conexión para separar un problema de acceso o modelo del formato de la lectura',
    );
  }
  if (response.status === 413)
    return fail(
      'GEMINI_IMAGE_TOO_LARGE',
      'Google rechazó el tamaño de la imagen. Recorta el documento o carga una fotografía más pequeña',
      422,
    );
  return fail(
    'GEMINI_UNAVAILABLE',
    'Google no pudo atender la solicitud. Vuelve a intentarlo más tarde',
  );
}
