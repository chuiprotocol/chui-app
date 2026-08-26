/** 後台呼叫 API 的薄封裝。session 走 httpOnly cookie（credentials: include）。 */

export const API_URL = (import.meta.env.VITE_CHUI_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number,
              public detail: Record<string, unknown> = {}) {
    super(message);
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const detail = (json?.detail ?? json) as Record<string, unknown>;
    throw new ApiError(
      String(detail?.code ?? `HTTP_${resp.status}`),
      String(detail?.message ?? `API 錯誤（${resp.status}）`),
      resp.status,
      detail,
    );
  }
  return json as T;
}
