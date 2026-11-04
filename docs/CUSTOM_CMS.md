# Custom CMS API v1

Any CMS can receive content from SEO Automation Hub by implementing this small JSON API. Choose **Custom CMS** as the website's platform and connect it with the API base URL and a bearer token. A working reference implementation is in [`dev/mock-cms/custom.ts`](../dev/mock-cms/custom.ts). It runs on `http://localhost:8790/api/v1` with `npm run mock:cms`.

## Transport and authentication

- **HTTPS required** in production. Requests to private, loopback or link-local addresses are refused, as are non-standard ports. Redirects are not followed for writes.
- **Authentication:** every request sends `Authorization: Bearer <token>`. Issue a dedicated token that can create, update and publish posts. To revoke access, revoke the token.
- **Content type:** JSON (`application/json`) for both request and response bodies.
- **Errors:** errors use HTTP status codes. An optional body `{"message": "..."}` is shown to users (truncated to 300 characters).

| Status | Meaning to the hub |
| --- | --- |
| `401` | Token rejected. The job fails, the connection is marked *auth failed* and the user must reconnect. |
| `403` | Not allowed (for example, the token cannot publish). The job fails permanently. |
| `404` | Not found. `GET /posts/{id}` returning 404 means "the post no longer exists". |
| `409`, `422`, other `4xx` | The request was rejected. The job fails permanently. |
| `429` | Rate limited. The hub retries with backoff and honours `Retry-After` (in seconds). |
| `5xx`, timeouts | Temporary failure. The hub retries. A failed write is treated as ambiguous: before writing again, the hub looks the post up (see [Reconciliation](#reconciliation)). |

## Endpoints

All paths are relative to the API base URL, for example `https://cms.example.com/api/sah/v1`.

### `GET /site`

Returns the site description used to test the connection.

```json
{
  "name": "Example Site",
  "url": "https://www.example.com",
  "user": { "id": "svc-seo-hub", "name": "SEO Hub service account" },
  "capabilities": { "publish": true, "seo_fields": ["meta_title", "meta_description", "canonical_url"] }
}
```

- `capabilities.publish`: if this is `false`, the hub refuses to connect.
- `capabilities.seo_fields`: lists the SEO fields that the CMS stores and renders. The hub sends only these fields. Any field not listed is shown as *not sent* in the app.

### `GET /posts?limit=<n>&slug=<slug>`

Returns `{"items": [Post, ...]}`. If `slug` is given, return the posts whose slug is exactly that value.

### `GET /posts/{id}`

Returns a `Post`, or `404` if no post has that ID.

### `POST /posts`

Creates a **draft**. It must not be publicly visible. The request body:

```json
{
  "title": "Internal linking guide",
  "slug": "internal-linking-guide",
  "content_html": "<p>…</p>",
  "excerpt": "Short summary",
  "status": "draft",
  "seo": { "meta_title": "…", "meta_description": "…", "canonical_url": "https://…" }
}
```

- `seo` contains only the fields listed in `capabilities.seo_fields`, and only the ones that have a value.
- On success, return `201` with the created `Post`. If the slug is already used, return `409`.

### `PATCH /posts/{id}`

Updates the post. The body has the same fields as `POST /posts`, without `status`. Return the updated `Post`.

If the post is already published, apply the update to the live version as well, or stage it until the next publish call. The hub calls publish again after every update.

### `POST /posts/{id}/publish`

Makes the post live. Return the `Post` with `"status": "published"` and its public `url`.

The call must be idempotent: publishing an already-published post returns it unchanged.

### `Post` object

```json
{
  "id": "p_123",
  "status": "draft",
  "slug": "internal-linking-guide",
  "title": "Internal linking guide",
  "url": "https://www.example.com/blog/internal-linking-guide",
  "seo": { "meta_title": "…", "meta_description": "…", "canonical_url": "…" }
}
```

| Field | Rules |
| --- | --- |
| `id` | String or number, 1–128 characters from `A–Z a–z 0–9 _ -`. |
| `status` | `draft`, `pending`/`review`, `scheduled` or `published`. Any other value is passed through unchanged. |
| `url` | The public URL once published. It may be `null` before that. |
| `seo` | Return the stored values. A field counts as *confirmed* only if the echoed value is exactly the value that was sent. |

## How the hub uses the API

1. **Connect:** calls `GET /site` and `GET /posts?limit=5`. Credentials are stored, encrypted, only if both succeed.
2. **Draft:** calls `POST /posts`, or `PATCH /posts/{id}` if the post already exists.
3. **Publish** (approved content only): reconciles, creates or updates the post, stores the post ID, then calls `POST /posts/{id}/publish`.
4. **Verify:** fetches the returned `url` and checks four things: the page is reachable, the title and body are present, the post is indexable, and the confirmed SEO fields (`<title>`, `<meta name="description">`, `<link rel="canonical">`) appear on the page.

### Reconciliation

A write that timed out may still have succeeded, so before retrying the hub looks for an existing post:

1. By the stored post ID.
2. Otherwise by slug, which requires `GET /posts?slug=` to filter exactly.

A post found by slug is adopted only if its title matches. Otherwise the job fails with a slug conflict, and the hub never overwrites the existing post.
