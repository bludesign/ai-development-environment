import { expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { screenshotSessionToken } from "../scripts/mock-data/auth";
import { ids } from "../scripts/mock-data/ids";

test("portable mixed preset imports, exports, and calls only selected MCP tools", async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: baseURL,
  });
  const headers = { Authorization: `Bearer ${screenshotSessionToken}` };
  await page.setExtraHTTPHeaders(headers);
  const graphql = async (
    query: string,
    variables: Record<string, unknown> = {},
  ) => {
    const response = await page.request.post("/api/graphql", {
      headers,
      data: { query, variables },
    });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const created: string[] = [];
  const client = new Client({ name: "preset-acceptance", version: "1.0" });
  try {
    await page.goto("/en/system/tools");
    await page.getByText("Core Tools", { exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Export tool catalog", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Format", exact: true }).click();
    await page.getByRole("option", { name: "JSON", exact: true }).click();
    const catalogDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download", exact: true }).click();
    const catalogStream = await (await catalogDownload).createReadStream();
    let catalogContent = "";
    for await (const chunk of catalogStream!)
      catalogContent += chunk.toString();
    const catalog = JSON.parse(catalogContent);
    expect(catalog.presetSchema).toBeDefined();
    expect(catalogContent).not.toContain("127.0.0.1");
    expect(catalogContent).not.toContain(ids.externalMcpServers.linear);
    const external = catalog.groups.find(
      (group: { source: string }) => group.source === "EXTERNAL",
    );
    expect(external.tools[0].inputSchema.properties.query).toBeDefined();

    // A deterministic AI-style answer constructed only from exported references.
    const name = `Portable review ${testInfo.project.name}`;
    const portable = {
      format: "aide.mcp-presets.export",
      schemaVersion: 1,
      externalServers: catalog.externalServers,
      presets: [
        {
          name,
          description: "Inspect codebases and issues",
          iconKey: "wrench",
          enabledForPlans: true,
          enabledForSessions: true,
          tools: [
            { source: "BUILTIN", name: "get_codebases" },
            external.tools[0].reference,
          ],
        },
      ],
    };
    await page
      .getByRole("button", { name: "Import presets", exact: true })
      .click();
    const aiPrompt = page.getByRole("button", {
      name: "Prompt for an AI to create presets",
      exact: true,
    });
    await aiPrompt.hover();
    await expect(aiPrompt).toHaveCSS("text-decoration-line", "none");
    await aiPrompt.click();
    await expect(
      page.getByLabel("AI preset generation prompt", { exact: true }),
    ).toBeVisible();
    const copiedPrompt = await page
      .getByLabel("AI preset generation prompt", { exact: true })
      .inputValue();
    expect(copiedPrompt).toContain('"format": "aide.mcp-presets.export"');
    await page
      .getByRole("button", { name: "Copy AI prompt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Prompt copied", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      copiedPrompt,
    );
    await aiPrompt.click();
    await page.getByLabel("Preset JSON file", { exact: true }).setInputFiles({
      name: "portable-presets.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(portable)),
    });
    await expect(page.getByLabel("Preset JSON", { exact: true })).toHaveValue(
      JSON.stringify(portable),
    );
    await page
      .getByLabel("Preset JSON", { exact: true })
      .fill(JSON.stringify(portable, null, 2));
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    const map = page.getByLabel("Map Linear to a configured server");
    await expect(map).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Import reviewed presets",
        exact: true,
      }),
    ).toBeDisabled();
    await map.click();
    await page
      .getByRole("option", { name: "Linear (suggested)", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review import", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Import reviewed presets",
        exact: true,
      }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Import reviewed presets", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    const list = await graphql(
      "query { mcpToolPresets { id name tools { source serverId name } } }",
    );
    const saved = list.mcpToolPresets.find(
      (preset: { name: string }) => preset.name === name,
    );
    expect(saved).toBeDefined();
    created.push(saved.id);
    expect(saved.tools).toHaveLength(2);

    const exportedFile = page.waitForEvent("download");
    await page
      .getByRole("button", { name: `Export ${name}`, exact: true })
      .click();
    const exportStream = await (await exportedFile).createReadStream();
    let exportContent = "";
    for await (const chunk of exportStream!) exportContent += chunk.toString();
    const exported = JSON.parse(exportContent);
    expect(exported.presets[0].tools).toEqual(
      expect.arrayContaining(portable.presets[0].tools),
    );
    expect(exportContent).not.toContain(saved.id);
    expect(exportContent).not.toContain(ids.externalMcpServers.linear);

    exported.presets[0].name += " round trip";
    const input = {
      document: JSON.stringify(exported),
      serverMappings: [
        {
          serverKey: exported.externalServers[0].key,
          serverId: ids.externalMcpServers.linear,
        },
      ],
    };
    const review = await graphql(
      "query($input: McpToolPresetImportInput!) { previewMcpToolPresetImport(input: $input) { token canImport errors entries { errors } } }",
      { input },
    );
    expect(review.previewMcpToolPresetImport.canImport).toBe(true);
    const imported = await graphql(
      "mutation($input: McpToolPresetImportInput!, $token: String!) { importMcpToolPresets(input: $input, previewToken: $token) { id tools { source serverId name } } }",
      { input, token: review.previewMcpToolPresetImport.token },
    );
    created.push(imported.importMcpToolPresets[0].id);
    expect(imported.importMcpToolPresets[0].tools).toEqual(saved.tools);

    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`/api/mcp?preset=${saved.id}`, baseURL),
        { requestInit: { headers } },
      ),
    );
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(2);
    expect(tools.tools.map((tool) => tool.name)).toContain("get_codebases");
    const proxied = tools.tools.find((tool) =>
      tool.name.startsWith("aide_ext_"),
    )!;
    expect(proxied).toBeDefined();
    const result = await client.callTool({
      name: proxied.name,
      arguments: { query: "quick search" },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      issues: [
        {
          key: "ACME-1234",
          title: "Add quick search to the global navigation bar",
        },
      ],
    });
    const denied = await client.callTool({
      name: "get_agent_runs",
      arguments: {},
    });
    expect(denied.isError).toBe(true);
  } finally {
    await client.close();
    for (const id of created)
      await graphql(
        "mutation($id: ID!) { deleteMcpToolPreset(id: $id) { id } }",
        { id },
      );
  }
});
