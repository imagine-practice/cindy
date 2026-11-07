/** Unit G2-B1: real MCP Client/InMemoryTransport/server discovery and dispatch.
 * G2-A registry tests cannot detect missing public registration or false old-host
 * capability claims. Host callbacks below are controlled: no real DB, actor access,
 * provider wiring, group execution, network/model or cross-device parity is proved.
 * Modules load once; no resetModules or real waits. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createXdtHelperMcpServer } from "../lizi_xdtHelperMcpServer.js";
import type {
  EntityProject,
  EntityProjectCallbacks,
  EntityProjectProgress,
} from "../xdt-helper/entity_projects.js";
import type { LiziMcpSessionContext } from "../types.js";

const entity = (id: string): EntityProject => ({
  id,
  name: "Same name",
  goal: null,
  ownerId: "owner",
  status: "active",
  members: [],
  taskCount: 0,
  createdAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
});
const parse = (result: unknown) =>
  JSON.parse((result as { content: { text: string }[] }).content[0].text);
async function connect(wired = true) {
  let context: LiziMcpSessionContext | undefined = {
    agentKind: "pi",
    workingDir: "/repo",
    sessionId: "trusted-caller",
  };
  const list = vi.fn<EntityProjectCallbacks["list"]>(async () => ({
    ok: true,
    projects: [entity("p1"), entity("p2")],
  }));
  const detail = vi.fn<EntityProjectCallbacks["detail"]>(
    async ({ projectId }) => ({
      ok: true,
      project: entity(projectId),
      workItems: [],
    }),
  );
  const progress = vi.fn<EntityProjectCallbacks["progress"]>(
    async ({ projectId }) => ({
      ok: true,
      projectId,
      items: Array.from({ length: 120 }, (_, i) => ({
        sessionId: `s${i}`,
        projectId,
        title: "Item",
        sessionStatus: "active",
        bindingRevision: 3,
        progress: null,
      })),
      history: [],
      capabilities: { canRecord: true, canConfirmDone: false },
      historyPage: { limit: 100, hasMore: true, nextBeforeEventId: 2 },
    }),
  );
  const directoryList = vi.fn(async () => ({
    ok: true as const,
    projects: [
      {
        workingDir: "/repo",
        directoryName: "repo",
        alias: null,
        hidden: false,
        exists: true,
        lastUsedAt: "2026-11-05T00:00:00Z",
      },
    ],
    total: 1,
    nextOffset: null,
    projectsRoot: {
      path: "/projects",
      source: "setting" as const,
      exists: true,
    },
  }));
  const createProject = vi.fn(async () => ({
    ok: true as const,
    workingDir: "/repo",
  }));
  const server = createXdtHelperMcpServer(
    {
      ...(wired ? { entityProjects: { list, detail, progress } } : {}),
      createProject,
      projectManagement: {
        list: directoryList,
        rename: async () => ({ ok: true, workingDir: "/repo", alias: null }),
        remove: async () => ({ ok: true, workingDir: "/repo", removed: true }),
      },
    },
    { agentKind: "pi", workingDir: "/repo", getSessionContext: () => context },
  );
  const client = new Client({
    name: "entity-project-server-test",
    version: "1",
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    list,
    detail,
    progress,
    directoryList,
    createProject,
    setContext: (next: typeof context) => {
      context = next;
    },
    async call(name: string, args: object = {}) {
      return parse(
        await client.callTool({ name: "call_tool", arguments: { name, args } }),
      );
    },
    async discover(category?: string) {
      return parse(
        await client.callTool({
          name: "list_tools",
          arguments: category ? { category } : {},
        }),
      );
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

describe("entity project public MCP wiring", () => {
  it("discovers and calls supplied entity callbacks alongside unchanged directory tools", async () => {
    const h = await connect();
    try {
      const names = (await h.discover("control")).tools.map(
        (tool: { name: string }) => tool.name,
      );
      expect(names).toEqual(
        expect.arrayContaining([
          "list_project_entities",
          "get_project_entity",
          "get_project_progress",
          "list_projects",
          "create_project",
        ]),
      );
      const projects = await h.call("list_project_entities");
      expect(
        projects.projects.map((project: EntityProject) => project.id),
      ).toEqual(["p1", "p2"]);
      expect(projects).not.toHaveProperty("project_path");
      expect(
        await h.call("get_project_entity", { project_id: "p2" }),
      ).toMatchObject({ ok: true, project: { id: "p2" } });
      expect(h.detail).toHaveBeenCalledWith({
        callerSessionId: "trusted-caller",
        projectId: "p2",
      });
      expect(await h.call("list_projects")).toMatchObject({
        ok: true,
        projects: [{ project_path: "/repo" }],
        total: 1,
      });
      expect(
        await h.call("create_project", { working_dir: "/repo" }),
      ).toMatchObject({ ok: true, project_path: "/repo" });
      expect(h.directoryList).toHaveBeenCalledWith({
        callerSessionId: "trusted-caller",
        includeHidden: true,
        offset: 0,
        limit: 100,
      });
      const info = await h.call("get_capabilities", { key: "self-management" });
      expect(info.entityProjects).toMatchObject({
        registered: true,
        scope: "host-local",
      });
      expect(info.capability.detail).toContain("project_path");
      expect(info.capability.detail).toContain("list_project_entities");
    } finally {
      await h.close();
    }
  });

  it("does not discover or call new tools when callbacks are absent, and says so in the index", async () => {
    const h = await connect(false);
    try {
      const names = (await h.discover("control")).tools.map(
        (tool: { name: string }) => tool.name,
      );
      expect(names).toContain("list_projects");
      expect(names).not.toContain("list_project_entities");
      for (const name of [
        "list_project_entities",
        "get_project_entity",
        "get_project_progress",
      ]) {
        expect((await h.call(name, { project_id: "p1" })).errorCode).toBe(
          "UNKNOWN_TOOL",
        );
      }
      const info = await h.call("get_capabilities", { key: "self-management" });
      expect(info.entityProjects.registered).toBe(false);
      expect(info.entityProjects.note).toContain("未注册");
      expect(h.list).not.toHaveBeenCalled();
      expect(h.progress).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("rejects identity fields through public call_tool before any host callback", async () => {
    const h = await connect();
    try {
      for (const extra of [
        { actor: { kind: "account", id: "owner" } },
        { role: "owner" },
        { now: 1 },
        { botId: "bot" },
      ]) {
        expect(
          (await h.call("get_project_entity", { project_id: "p1", ...extra }))
            .errorCode,
        ).toBe("INVALID_ARGS");
      }
      expect(h.detail).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  it("pages history without truncating current items or dropping binding revisions", async () => {
    const h = await connect();
    try {
      const result = await h.call("get_project_progress", {
        project_id: "p1",
        before_event_id: 101,
      });
      expect(result.items).toHaveLength(120);
      expect(result.items[0]).toMatchObject({
        bindingRevision: 3,
        progress: null,
      });
      expect(result.historyPage).toEqual({
        limit: 100,
        hasMore: true,
        nextBeforeEventId: 2,
      });
      expect(h.progress).toHaveBeenCalledWith({
        callerSessionId: "trusted-caller",
        projectId: "p1",
        beforeEventId: 101,
      });
      expect(
        (
          await h.call("get_project_progress", {
            project_id: "p1",
            before_event_id: 0,
          })
        ).errorCode,
      ).toBe("INVALID_ARGS");
      expect(h.progress).toHaveBeenCalledTimes(1);
    } finally {
      await h.close();
    }
  });

  it("preserves service refusal instead of returning an empty successful project", async () => {
    const h = await connect();
    try {
      h.detail.mockResolvedValue({
        ok: false,
        errorCode: "NOT_PROJECT_MEMBER",
        message: "Membership was revoked",
      });
      expect(await h.call("get_project_entity", { project_id: "p1" })).toEqual({
        ok: false,
        errorCode: "NOT_PROJECT_MEMBER",
        data: { hint: "Membership was revoked" },
      });
    } finally {
      await h.close();
    }
  });

  it("rejects missing live context or remote execution without calling local callbacks", async () => {
    const h = await connect();
    try {
      h.setContext(undefined);
      expect(
        (await h.call("get_project_entity", { project_id: "p1" })).errorCode,
      ).toBe("NO_SESSION_CONTEXT");
      h.setContext({
        agentKind: "pi",
        sessionId: "remote-caller",
        workingDir: "/repo",
        remoteHostId: "remote",
      });
      expect(
        (await h.call("get_project_entity", { project_id: "p1" })).errorCode,
      ).toBe("UNSUPPORTED_CAPABILITY");
      const info = await h.call("get_capabilities", { key: "self-management" });
      expect(info.entityProjects.note).toContain("不降级本机");
      expect(h.detail).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
