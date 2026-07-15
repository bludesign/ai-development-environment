export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { SharedGraphQLServerService } =
    await import("@/services/graphql-server/graphql-server.service");

  await SharedGraphQLServerService.initialize();
}
