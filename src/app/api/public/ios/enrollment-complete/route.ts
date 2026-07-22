export const runtime = "nodejs";

const DEVICE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function GET(request: Request): Response {
  const deviceId = new URL(request.url).searchParams.get("deviceId");
  const deviceHref =
    deviceId && DEVICE_ID_PATTERN.test(deviceId)
      ? `/devices/${encodeURIComponent(deviceId)}`
      : null;
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Device received</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: Canvas; color: CanvasText; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.5rem; }
      p { line-height: 1.5; opacity: .75; }
      a { display: inline-block; margin-top: .5rem; border-radius: .5rem; background: #18181b; color: #fafafa; padding: .7rem 1rem; font-size: .9rem; font-weight: 600; text-decoration: none; }
      @media (prefers-color-scheme: dark) { a { background: #fafafa; color: #18181b; } }
    </style>
  </head>
  <body><main><h1>Device received</h1><p>The device information was validated. You can close this page or open the device dashboard.</p>${deviceHref ? `<a href="${deviceHref}">View device</a>` : ""}</main></body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
