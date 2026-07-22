export function parseRequestHeader(value: string): [string, string] {
  const separator = value.indexOf(":");
  if (separator <= 0) {
    throw new Error('--header must use the format "Name: value"');
  }
  const name = value.slice(0, separator).trim();
  const headerValue = value.slice(separator + 1).trim();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error(`Invalid HTTP header name: ${name || "(empty)"}`);
  }
  if (!headerValue || /[^\t\x20-\x7e\x80-\xff]/.test(headerValue)) {
    throw new Error(`Invalid value for HTTP header ${name}`);
  }
  return [name, headerValue];
}

export function requestHeaders(values: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const value of values) {
    const [name, headerValue] = parseRequestHeader(value);
    headers[name] = headerValue;
  }
  return headers;
}

export function redactedRequestHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.keys(headers ?? {}).map((name) => [name, "[redacted]"]),
  );
}
