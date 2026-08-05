import { beforeEach, describe, expect, test, vi } from "vitest";

const getServerServices = vi.hoisted(() => vi.fn());
const requireUserRequest = vi.hoisted(() => vi.fn());
vi.mock("@/services/server-services", () => ({ getServerServices }));
vi.mock("@/services/auth", () => ({ requireUserRequest }));

import { CodebaseLookupError } from "@/services/codebases";

import { GET as listCodebases } from "./route";
import { GET as getCodebaseByPath } from "./by-path/route";

describe("codebases REST routes", () => {
  const list = vi.fn();
  const getByPath = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    requireUserRequest.mockResolvedValue(null);
    getServerServices.mockReturnValue({
      codebaseToolsService: { list, getByPath },
    });
  });

  test("lists codebases", async () => {
    list.mockResolvedValue([{ id: "codebase-1", path: "/repo" }]);

    const response = await listCodebases(
      new Request("http://localhost/api/codebases"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      codebases: [{ id: "codebase-1", path: "/repo" }],
    });
  });

  test("rejects an anonymous request before reading codebase data", async () => {
    requireUserRequest.mockResolvedValue(
      Response.json({ error: "Authentication required" }, { status: 401 }),
    );

    const response = await listCodebases(
      new Request("http://localhost/api/codebases"),
    );

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  test("validates and resolves path lookups", async () => {
    const missingPath = await getCodebaseByPath(
      new Request("http://localhost/api/codebases/by-path"),
    );
    expect(missingPath.status).toBe(400);

    getByPath.mockResolvedValue({ id: "codebase-1", path: "/repo" });
    const response = await getCodebaseByPath(
      new Request("http://localhost/api/codebases/by-path?path=%2Frepo"),
    );
    expect(getByPath).toHaveBeenCalledWith("/repo");
    expect(response.status).toBe(200);
  });

  test("maps missing and ambiguous domain errors", async () => {
    getByPath.mockRejectedValueOnce(
      new CodebaseLookupError("CODEBASE_NOT_FOUND", "missing"),
    );
    const missing = await getCodebaseByPath(
      new Request("http://localhost/api/codebases/by-path?path=%2Fmissing"),
    );
    expect(missing.status).toBe(404);

    getByPath.mockRejectedValueOnce(
      new CodebaseLookupError("AMBIGUOUS_PATH", "ambiguous", [
        { agentId: "agent-1", name: "Studio", hostname: "studio.local" },
      ]),
    );
    const ambiguous = await getCodebaseByPath(
      new Request("http://localhost/api/codebases/by-path?path=%2Frepo"),
    );
    expect(ambiguous.status).toBe(409);
    await expect(ambiguous.json()).resolves.toMatchObject({
      error: { code: "AMBIGUOUS_PATH", matches: [{ agentId: "agent-1" }] },
    });
  });
});
