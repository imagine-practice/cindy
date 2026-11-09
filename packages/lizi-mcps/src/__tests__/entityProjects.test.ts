/** Unit G2-A: real strict registry/schema -> handler -> controlled host callback.
 * Existing directory-tool tests do not cover entity IDs, spoofed actors or complete
 * items alongside paged history. No database/IPC/remote authorization integration
 * is asserted; callbacks are controlled, no model/network/writes or real waits.
 */
import { describe, expect, it, vi } from "vitest";
import { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import {
  registerEntityProjectTools,
  type EntityProject,
  type EntityProjectCallbacks,
  type EntityProjectProgress,
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
const parse = (result: { content: unknown[] }) =>
  JSON.parse((result.content[0] as { text: string }).text);
function setup() {
  let context: LiziMcpSessionContext | undefined = {
    agentKind: "codex",
    workingDir: "/repo",
    sessionId: "trusted-session",
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
      items: [],
      history: [],
      capabilities: { canRecord: false, canConfirmDone: false },
      historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null },
    }),
  );
  const registry = new XdtHelperToolRegistry();
  registerEntityProjectTools(registry, {
    getSessionContext: () => context,
    callbacks: { list, detail, progress },
  });
  return {
    registry,
    list,
    detail,
    progress,
    setContext: (next: typeof context) => {
      context = next;
    },
  };
}

describe("read-only entity project tools", () => {
  it("discovers exactly three read-only definitions without replacing directory tools", async () => {
    const h = setup();
    expect(h.registry.list("control").map((tool) => tool.name)).toEqual([
      "list_project_entities",
      "get_project_entity",
      "get_project_progress",
    ]);
    expect(h.registry.has("list_projects")).toBe(false);
    expect(h.registry.has("create_project")).toBe(false);
    const result = parse(await h.registry.call("list_project_entities", {}));
    expect(result.projects.map((project: EntityProject) => project.id)).toEqual(
      ["p1", "p2"],
    );
    expect(result).not.toHaveProperty("nextCursor");
    expect(h.list).toHaveBeenCalledWith({ callerSessionId: "trusted-session" });
    await h.registry.call("get_project_entity", {
      project_id: result.projects[1].id,
    });
    expect(h.detail).toHaveBeenCalledWith({
      callerSessionId: "trusted-session",
      projectId: "p2",
    });
  });
  it.each([
    undefined,
    { agentKind: "codex", workingDir: "/repo" },
    { agentKind: "codex", workingDir: "/repo", sessionId: "" },
  ])("rejects missing trusted context %j", (context) => {
    const h = setup();
    h.setContext(context as LiziMcpSessionContext | undefined);
    return h.registry.call("list_project_entities", {}).then((result) => {
      expect(parse(result).errorCode).toBe("NO_SESSION_CONTEXT");
      expect(h.list).not.toHaveBeenCalled();
    });
  });
  it.each([
    { remoteHostId: "ssh-host" },
    { vendorOptions: { orcaRemoteLead: { deviceId: "remote" } } },
  ])(
    "rejects unsupported remote context without defaulting local: %j",
    (patch) => {
      const h = setup();
      h.setContext({
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "remote-task",
        ...patch,
      });
      return h.registry
        .call("get_project_entity", { project_id: "p1" })
        .then((result) => {
          expect(parse(result).errorCode).toBe("UNSUPPORTED_CAPABILITY");
          expect(h.detail).not.toHaveBeenCalled();
        });
    },
  );
  it.each([
    "actor",
    "role",
    "now",
    "callerSessionId",
    "device",
    "project_path",
    "working_dir",
  ])(
    "strictly rejects forged/legacy field %s before callbacks",
    async (field) => {
      const h = setup();
      for (const name of [
        "list_project_entities",
        "get_project_entity",
        "get_project_progress",
      ]) {
        const args =
          name === "list_project_entities" ? {} : { project_id: "p1" };
        expect(
          parse(await h.registry.call(name, { ...args, [field]: "forged" }))
            .errorCode,
        ).toBe("INVALID_ARGS");
      }
      expect(h.list).not.toHaveBeenCalled();
      expect(h.detail).not.toHaveBeenCalled();
      expect(h.progress).not.toHaveBeenCalled();
    },
  );
  it.each(["/repo", "C:\\repo", "device::p1", "", "x".repeat(201)])(
    "does not substitute directory/remote identifiers %s",
    async (project_id) => {
      const h = setup();
      expect(
        parse(await h.registry.call("get_project_entity", { project_id }))
          .errorCode,
      ).toBe("INVALID_ARGS");
      expect(h.detail).not.toHaveBeenCalled();
    },
  );
  it.each([null, 0, -1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid history cursor %j",
    async (before_event_id) => {
      const h = setup();
      expect(
        parse(
          await h.registry.call("get_project_progress", {
            project_id: "p1",
            before_event_id,
          }),
        ).errorCode,
      ).toBe("INVALID_ARGS");
      expect(h.progress).not.toHaveBeenCalled();
    },
  );
  it("preserves host rejection code and safe message without fabricating success", async () => {
    const h = setup();
    h.detail.mockResolvedValue({
      ok: false,
      errorCode: "NOT_PROJECT_MEMBER",
      message: "Membership revoked",
    });
    const result = await h.registry.call("get_project_entity", {
      project_id: "p1",
    });
    expect(result.isError).toBe(true);
    expect(parse(result)).toEqual({
      ok: false,
      errorCode: "NOT_PROJECT_MEMBER",
      data: { hint: "Membership revoked" },
    });
  });
  it("retains full items, unknown and binding epochs while paging history and strips private extras", async () => {
    const h = setup();
    const data: EntityProjectProgress = {
      projectId: "p1",
      items: Array.from({ length: 120 }, (_, i) => ({
        sessionId: `s${i}`,
        projectId: "p1",
        title: "Task",
        sessionStatus: "active",
        bindingRevision: 4,
        progress: null,
      })),
      history: [
        {
          eventId: 2,
          projectId: "p1",
          sessionId: "s0",
          bindingRevision: 0,
          from: null,
          to: "done",
          actor: { kind: "bot", id: "bot", displayName: null },
          createdAt: 1,
          reason: null,
          unblockCondition: null,
          resolution: null,
          completionNote: "Progress only",
        },
      ],
      capabilities: { canRecord: true, canConfirmDone: false },
      historyPage: { limit: 100, hasMore: true, nextBeforeEventId: 2 },
    };
    data.items[0].progress = {
      sessionId: "s0",
      projectId: "p1",
      bindingRevision: 4,
      revision: 7,
      status: "blocked",
      reason: "Waiting for input",
      unblockCondition: "Input provided",
      completionEventId: null,
      updatedBy: { kind: "bot", id: "bot" },
      updatedAt: 42,
    };
    const extended = {
      ...data,
      storageRef: "private",
      intent_json: "private",
      items: data.items.map((item) => ({ ...item, storageRef: "private" })),
      history: data.history.map((event) => ({
        ...event,
        after_json: "private",
        actor: { ...event.actor, secret: "private" },
      })),
    };
    h.progress.mockResolvedValue({ ok: true, ...extended });
    const result = parse(
      await h.registry.call("get_project_progress", {
        project_id: "p1",
        before_event_id: 101,
      }),
    );
    expect(h.progress).toHaveBeenCalledWith({
      callerSessionId: "trusted-session",
      projectId: "p1",
      beforeEventId: 101,
    });
    expect(result).toEqual({ ok: true, ...data });
    expect(result.items).toHaveLength(120);
    expect(JSON.stringify(result)).not.toMatch(
      /storageRef|intent_json|after_json|private/,
    );
  });
  it("strips non-public list/detail fields and rejects malformed host results without echoing payloads", async () => {
    const h = setup();
    const extendedList = {
      ok: true as const,
      projects: [
        { ...entity("p1"), workingDir: "/private", storageRef: "private" },
      ],
    };
    h.list.mockResolvedValue(extendedList);
    expect(parse(await h.registry.call("list_project_entities", {}))).toEqual({
      ok: true,
      projects: [entity("p1")],
    });
    const extendedDetail = {
      ok: true as const,
      project: { ...entity("p1"), storageRef: "private" },
      workItems: [],
    };
    h.detail.mockResolvedValue(extendedDetail);
    expect(
      parse(await h.registry.call("get_project_entity", { project_id: "p1" })),
    ).toEqual({ ok: true, project: entity("p1"), workItems: [] });
    h.progress.mockResolvedValue({ ok: true, storageRef: "private" } as never);
    const result = parse(
      await h.registry.call("get_project_progress", { project_id: "p1" }),
    );
    expect(result.errorCode).toBe("INTERNAL");
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("only invokes read callbacks and preserves omitted cursor without inventing one", async () => {
    const h = setup();
    const write = vi.fn();
    const callbacks = {
      list: h.list,
      detail: h.detail,
      progress: h.progress,
      write,
    };
    const registry = new XdtHelperToolRegistry();
    registerEntityProjectTools(registry, {
      getSessionContext: () => ({
        agentKind: "codex",
        workingDir: "/repo",
        sessionId: "caller",
      }),
      callbacks,
    });
    await registry.call("list_project_entities", {});
    await registry.call("get_project_entity", { project_id: "p1" });
    await registry.call("get_project_progress", { project_id: "p1" });
    expect(h.progress).toHaveBeenCalledWith({
      callerSessionId: "caller",
      projectId: "p1",
    });
    expect(write).not.toHaveBeenCalled();
    expect(
      parse(await registry.call("update_project_entity", {})).errorCode,
    ).toBe("UNKNOWN_TOOL");
  });
});
