export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { SharedGraphQLServerService } =
      await import("@/services/graphql-server/graphql-server.service");
    void SharedGraphQLServerService.initialize();
  }
}
