import { SharedGraphQLServerService } from "@/services/graphql-server/graphql-server.service";

// Next.js runs register() once at server startup. Warm the Apollo server + Prisma client here
// so the first GraphQL request doesn't pay initialization cost. Node.js runtime only.
export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    void SharedGraphQLServerService.initialize();
  }
}
