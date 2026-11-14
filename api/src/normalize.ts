const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid", "yclid", "_hsenc",
  "_hsmi", "ref", "ref_src",
]);

export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  if (url.protocol === "http:") url.protocol = "https:";
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  const params = url.searchParams;
  const kept: [string, string][] = [];
  for (const [k, v] of params) {
    if (!TRACKING_PARAMS.has(k)) kept.push([k, v]);
  }
  params.forEach(() => {});
  url.search = "";
  for (const [k, v] of kept.sort(([a], [b]) => a.localeCompare(b))) {
    url.searchParams.append(k, v);
  }
  let pathAndQuery = url.pathname + url.search;
  if (pathAndQuery === "/") pathAndQuery = "";
  return `${url.protocol}//${url.host}${pathAndQuery}`;
}

export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}