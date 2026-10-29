/** Route the documentation fixture's GitLab API to the local stub, including forced reads. */
const destination = process.env.SCREENSHOT_GITLAB_API_ORIGIN;

if (destination) {
  const mockOrigin = new URL(destination);
  if (mockOrigin.hostname !== "127.0.0.1" || mockOrigin.protocol !== "http:") {
    throw new Error(
      "SCREENSHOT_GITLAB_API_ORIGIN must use the local screenshot stub",
    );
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (
      url.origin === "https://gitlab.acme.example.com" &&
      url.pathname.startsWith("/gitlab/api/v4/")
    ) {
      const target = new URL(url.pathname + url.search, mockOrigin);
      return originalFetch(
        input instanceof Request ? new Request(target, input) : target,
        init,
      );
    }
    return originalFetch(input, init);
  };
}
