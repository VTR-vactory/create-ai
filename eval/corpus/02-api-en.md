# Lumen Desk API Guide

Version: 1.0
Base URL: `https://api.lumendesk.example/v1`

The Lumen Desk API lets you upload knowledge documents and ask questions against a workspace. All responses are JSON. Streaming responses use Server-Sent Events.

## Authentication

Every request must include an API key in the `Authorization` header:

```
Authorization: Bearer <API_KEY>
```

Keys are scoped to a single workspace. A key created for one workspace cannot read documents or answers from another workspace.

You may send an optional `X-Request-Id` header. If present, the API echoes it in the response and includes it in server logs, which makes support investigations easier. If omitted, the server generates one.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/answers` | Ask a question, optionally with attachments |
| POST | `/documents` | Upload a text document |
| GET | `/documents/{id}` | Get document metadata and status |
| DELETE | `/documents/{id}` | Delete a document and its chunks |
| GET | `/health` | Liveness check |

## Ask a question

`POST /answers`

```json
{
  "question": "What is the default refund period?",
  "attachment_ids": ["doc_123"],
  "web_search": false,
  "stream": false
}
```

- `question` is required and limited to 2,000 characters.
- `attachment_ids` is optional. The maximum number of attachments depends on the plan; the API returns `VALIDATION_ERROR` when the limit is exceeded.
- `web_search` defaults to `false`. When `true`, the server may use web results only if workspace retrieval returns nothing.
- `stream` defaults to `false`.

Non-streaming response:

```json
{
  "answer": "The default refund period is 14 business days.",
  "citations": [
    {
      "index": 1,
      "title": "Lumen Desk 产品说明",
      "url": "https://docs.lumendesk.example/product"
    }
  ],
  "usage": {
    "prompt_tokens": 812,
    "completion_tokens": 96
  },
  "request_id": "req_8f2c1a"
}
```

When `stream` is `true`, the response uses `text/event-stream` and emits incremental text chunks, followed by a final event containing citations and usage. The server stops generation when the client disconnects.

If no workspace document and no web result exceeds the relevance threshold, the API returns `NO_BASIS` and does not call the language model.

## Documents

`POST /documents` accepts `multipart/form-data` with a `file` field. Text formats are Markdown, TXT, and CSV. Images are accepted for preview but are not indexed.

Upload response:

```json
{
  "id": "doc_123",
  "name": "product.md",
  "status": "PROCESSING",
  "created_at": "2026-10-22T08:00:00Z"
}
```

Document status values:

- `PROCESSING`: chunks are being embedded.
- `READY`: all chunks were indexed.
- `PARTIAL`: some chunks failed; `failed_chunks` reports the count.
- `FAILED`: no chunk could be indexed; see `error`.

`GET /documents?limit=20&cursor=...` returns documents in reverse creation order. `limit` defaults to 20 and cannot exceed 100. Use the returned `next_cursor` for pagination.

`DELETE /documents/{id}` removes the document and all of its chunks. It does not delete conversations that referenced the document.

## Errors

Errors use a single envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "question must not be empty",
    "request_id": "req_8f2c1a"
  }
}
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Invalid or missing parameters |
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 403 | `FORBIDDEN` | Key does not belong to this workspace |
| 404 | `NOT_FOUND` | Document does not exist |
| 409 | `DUPLICATE` | Same content already uploaded |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL` | Unexpected server error |

A `429` response includes `Retry-After` in seconds. Clients should respect it and retry with exponential backoff.

## Rate limits

The default limit is 60 requests per minute per API key, with a burst allowance of 10 requests. Plan-specific overrides are listed in the limits table (`03-limits.csv`). The API returns the following headers on every response:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

Rate limiting happens before retrieval and model calls, so rejected requests do not consume model tokens.

## Webhooks

Workspaces can subscribe to document events:

- `document.ready`
- `document.failed`

Each delivery includes an `X-Lumen-Signature` header computed with HMAC-SHA256 over the raw request body. Failed deliveries are retried up to 3 times with exponential backoff. A delivery is considered successful when the endpoint returns any 2xx status within 10 seconds.

## Versioning

The API is versioned in the path (`/v1`). Breaking changes are introduced only in a new major path. Additive fields may appear in responses without a version bump, so clients must ignore unknown fields.
