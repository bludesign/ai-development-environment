export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initializeAppSecret } =
      await import("./server/initialize-app-secret");
    await initializeAppSecret();
    const { getMcpOAuthConfig } =
      await import("./services/auth/mcp-oauth-config");
    getMcpOAuthConfig();
    const { startAgentWebSocketServer } =
      await import("./instrumentation-node");
    await startAgentWebSocketServer();
  }
}
