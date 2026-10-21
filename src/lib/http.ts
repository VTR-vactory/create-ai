/** 统一的 API 错误响应：{ error: { code, message } } */
export function apiError(
  code: string,
  message: string,
  status = 400,
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { code, message } },
    headers ? { status, headers } : { status },
  );
}
