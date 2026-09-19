# src/lib/api

API client plumbing lands here:

- `client.ts` — typed client; base URL from `@/constants/config`
- `interceptors.ts` — auth header, error mapping, idempotency keys
- `errors.ts` — typed error taxonomy matching the API envelope

Nothing is implemented yet.
