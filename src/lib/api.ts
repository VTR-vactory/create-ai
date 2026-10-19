async function handle<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message ?? "请求失败，请稍后重试。");
  }
  return body as T;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  return handle<T>(response);
}

export async function postJson<T>(url: string, data: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handle<T>(response);
}

// 上传文件用：body 为 FormData，不能手动设 Content-Type（要让浏览器自动带 boundary）
export async function postForm<T>(url: string, data: FormData): Promise<T> {
  const response = await fetch(url, { method: "POST", body: data });
  return handle<T>(response);
}

export async function patchJson<T>(url: string, data: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handle<T>(response);
}

export async function deleteJson<T = void>(url: string): Promise<T> {
  const response = await fetch(url, { method: "DELETE" });
  return handle<T>(response);
}
