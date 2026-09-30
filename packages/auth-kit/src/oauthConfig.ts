const DEFAULT_GOOGLE_PLACEHOLDERS = ['your_google_client_id', 'your_google_client_secret'] as const;

/**
 * True when both an OAuth client id and secret are present and neither is a
 * placeholder string (e.g. a starter .env's "your_google_client_id"). Generic
 * so it can check Google, WeChat, or any future provider that ships a similar
 * clientId/clientSecret pair.
 */
export function isGoogleClientConfigured(
  clientId?: string,
  clientSecret?: string,
  placeholders: readonly string[] = DEFAULT_GOOGLE_PLACEHOLDERS
): boolean {
  return !!(
    clientId &&
    clientSecret &&
    !placeholders.includes(clientId) &&
    !placeholders.includes(clientSecret)
  );
}

export function getGoogleOAuthConfigFromEnv(env: Record<string, string | undefined> = process.env): { clientId: string; clientSecret: string } | undefined {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}
