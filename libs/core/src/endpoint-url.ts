export type EndpointUrlResult =
  { ok: true; url: string } | { ok: false; reason: string };

const ALLOWED_PORTS = ['443', '8443'];

/**
 * Registration-time check of a webhook URL: https only, no credentials, port
 * 443 or 8443. Returns the normalised URL, or a reason the developer can act
 * on.
 *
 * This is the first line of defence only. Whether the host resolves to a
 * private address is checked at connect time by the SSRF guard, because a name
 * can point somewhere else tomorrow.
 */
export function validateEndpointUrl(raw: string): EndpointUrlResult {
  if (!URL.canParse(raw)) {
    return {
      ok: false,
      reason: 'must be an absolute URL, for example https://example.com/hook',
    };
  }
  const url = new URL(raw);

  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'only https URLs are allowed' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'URLs with credentials are not allowed' };
  }
  // The URL parser reports the default port (443) as an empty string.
  if (url.port !== '' && !ALLOWED_PORTS.includes(url.port)) {
    return {
      ok: false,
      reason: `port ${url.port} is not allowed, use 443 or 8443`,
    };
  }
  return { ok: true, url: url.href };
}
