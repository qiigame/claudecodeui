/**
 * Parses one RFC 6750 Bearer credential for both REST and WebSocket auth.
 *
 * This intentionally lives in a dependency-light shared module: the upgrade
 * verifier runs before the normal application graph is initialized, so it
 * must not import database/frontmatter/provider modules merely to validate a
 * header.  Callers receive `null` for every other auth scheme, a duplicated
 * header value, or a credential containing delimiters/whitespace that could
 * hide another token.
 */
export function extractBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+\/-]+=*)[ \t]*$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * Parses a credential carried in a query-string value.
 *
 * Query parameters have no auth scheme, so the value is wrapped in the
 * canonical Bearer form before using the same alphabet/whitespace checks as
 * the Authorization header.  `unknown` intentionally rejects arrays and
 * objects produced by duplicate or nested query parameters; callers should
 * not choose an arbitrary first value when a request presents more than one.
 */
export function extractBearerTokenFromQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return candidate ? extractBearerToken(`Bearer ${candidate}`) : null;
}
