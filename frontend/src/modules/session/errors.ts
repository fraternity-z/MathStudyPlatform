import axios from 'axios';

/** 会话模块内部使用的请求错误，避免页面依赖 Axios 的响应结构。 */
export interface SessionRequestError {
  message: string;
  status?: number;
  code?: string;
}

interface SessionErrorPayload {
  detail?: unknown;
  message?: unknown;
  code?: unknown;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** 将请求库错误收敛为 session 模块自己的稳定错误契约。 */
export const toSessionRequestError = (
  error: unknown,
  fallback: string
): SessionRequestError => {
  if (!axios.isAxiosError<SessionErrorPayload>(error)) {
    return {
      message: error instanceof Error ? error.message : fallback,
    };
  }

  const payload = error.response?.data;
  const message = nonEmptyString(payload?.message)
    ?? nonEmptyString(payload?.detail)
    ?? (error.request && !error.response ? '无法连接到服务器，请检查网络' : undefined)
    ?? nonEmptyString(error.message)
    ?? fallback;
  const code = nonEmptyString(payload?.code);
  const status = error.response?.status;

  return {
    message,
    ...(status !== undefined ? { status } : {}),
    ...(code ? { code } : {}),
  };
};

export const isSessionNotFoundError = (
  error: SessionRequestError | null | undefined
): boolean => error?.status === 404
  || error?.code === 'NOT_FOUND'
  || error?.code === 'SESSION_NOT_FOUND';

/** 只有请求本身确定无效时才丢弃草稿 ID；暂态错误保留稳定 ID 供只读对账。 */
export const isDefinitiveDraftIdentityError = (
  error: SessionRequestError | null | undefined
): boolean => error?.code === 'SESSION_ID_CONFLICT'
  || error?.code === 'FIRST_CHAT_NOT_RESUMABLE'
  || error?.code === 'VALIDATION_ERROR'
  || error?.code === 'BAD_REQUEST'
  || error?.code === 'PAYLOAD_TOO_LARGE'
  || error?.status === 400
  || error?.status === 409
  || error?.status === 413
  || error?.status === 422;
