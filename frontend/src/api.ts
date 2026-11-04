import { useEffect, useState } from 'react';
import type { Api, Session } from './types';
export function makeApi(session: Session | null, tenant: string, onUnauthorized: () => void): Api {
  return async <T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await fetch('/api' + path, {
      method,
      signal,
      headers: {
        'content-type': 'application/json',
        ...(session
          ? { authorization: 'Bearer ' + session.accessToken, 'x-tenant-id': tenant }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
    if (!response.ok) {
      if (response.status === 401 && session) onUnauthorized();
      const message = data?.message;
      throw new Error(
        typeof message === 'string'
          ? message
          : Array.isArray(message)
            ? message
                .map((m: { field?: string; message?: string }) =>
                  [m.field, m.message].filter(Boolean).join(': '),
                )
                .join('; ')
            : 'No se pudo completar la operación. Intenta nuevamente.',
      );
    }
    return data as T;
  };
}
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const [result, setResult] = useState<{ key: string; data?: T; error: string; loading: boolean }>({
    key: '',
    error: '',
    loading: false,
  });
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setResult({ key, error: '', loading: true });
    const timer = setTimeout(() => {
      void load(controller.signal)
        .then((data) => {
          if (!controller.signal.aborted) setResult({ key, data, error: '', loading: false });
        })
        .catch((error) => {
          if (!controller.signal.aborted)
            setResult({ key, error: (error as Error).message, loading: false });
        });
    }, 120);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, enabled]);
  return result.key === key ? result : { data: undefined, error: '', loading: enabled };
}
export function exportCsv(filename: string, headers: string[], rows: (string | number | null)[][]) {
  const cell = (value: string | number | null) => {
    let text = String(value ?? '');
    if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(
    ['\uFEFF' + [headers, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')],
    { type: 'text/csv;charset=utf-8' },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
