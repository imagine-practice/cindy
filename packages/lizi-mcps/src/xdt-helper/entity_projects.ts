import { z } from "zod";
import type { ControlResult, LiziMcpSessionContext } from "../types.js";
import type { XdtHelperToolRegistry } from "../lizi_xdtHelperToolRegistry.js";
import { errorPayload, okPayload } from "./_payload.js";

// Wire projections mirror I1 projects.ts and frozen projectProgressApi.ts.
// Keep this package independent of desktop; schema objects strip non-public fields.
const subject = z.object({
  kind: z.enum(["account", "bot"]),
  id: z.string(),
  displayName: z.string().nullable(),
  avatar: z.string().nullable(),
  avatarColor: z.string().nullable(),
});
const project = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string().nullable(),
  ownerId: z.string(),
  status: z.enum(["active", "archived"]),
  members: z.array(
    z.object({
      subject,
      role: z.enum(["owner", "member"]),
      addedAt: z.string(),
    }),
  ),
  taskCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const detail = z.object({
  project,
  workItems: z.array(
    z.object({
      sessionId: z.string(),
      title: z.string(),
      status: z.string(),
      assignee: subject.nullable(),
      updatedAt: z.string(),
    }),
  ),
});
const actor = z.object({ kind: z.enum(["account", "bot"]), id: z.string() });
const status = z.enum(["todo", "doing", "blocked", "review", "done"]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const progressRecord = z.object({
  sessionId: z.string(),
  projectId: z.string(),
  bindingRevision: revision,
  status: status.nullable(),
  revision,
  reason: z.string().nullable(),
  unblockCondition: z.string().nullable(),
  completionEventId: z.number().int().positive().nullable(),
  updatedBy: actor,
  updatedAt: z.number(),
});
const progress = z.object({
  projectId: z.string(),
  items: z.array(
    z.object({
      sessionId: z.string(),
      projectId: z.string(),
      title: z.string(),
      sessionStatus: z.string(),
      bindingRevision: revision,
      progress: progressRecord.nullable(),
    }),
  ),
  history: z.array(
    z.object({
      eventId: z.number().int().positive(),
      projectId: z.string(),
      sessionId: z.string(),
      bindingRevision: revision,
      from: status.nullable(),
      to: status,
      actor: actor.extend({ displayName: z.string().nullable() }),
      createdAt: z.number(),
      reason: z.string().nullable(),
      unblockCondition: z.string().nullable(),
      resolution: z.string().nullable(),
      completionNote: z.string().nullable(),
    }),
  ),
  capabilities: z.object({
    canRecord: z.boolean(),
    canConfirmDone: z.boolean(),
  }),
  historyPage: z.object({
    limit: z.literal(100),
    hasMore: z.boolean(),
    nextBeforeEventId: z.number().int().positive().nullable(),
  }),
});

export type EntityProject = z.infer<typeof project>;
export type EntityProjectDetail = z.infer<typeof detail>;
export type EntityProjectProgress = z.infer<typeof progress>;

/** Trusted host callbacks MUST resolve actor/access from callerSessionId, recheck owner
 * after awaits and sanitize rejection messages. No actor or SQL comes from tool args.
 * list is complete: the current I1 service does not expose list pagination.
 */
export interface EntityProjectCallbacks {
  list(params: {
    callerSessionId: string;
  }): Promise<ControlResult<{ projects: EntityProject[] }, string>>;
  detail(params: {
    callerSessionId: string;
    projectId: string;
  }): Promise<ControlResult<EntityProjectDetail, string>>;
  progress(params: {
    callerSessionId: string;
    projectId: string;
    beforeEventId?: number;
  }): Promise<ControlResult<EntityProjectProgress, string>>;
}

/** Definition module only. Public server registration/discovery is a later integration. */
export function registerEntityProjectTools(
  registry: XdtHelperToolRegistry,
  deps: {
    getSessionContext: () => LiziMcpSessionContext | undefined;
    callbacks: EntityProjectCallbacks;
  },
): void {
  const projectId = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine(
      (value) =>
        !/[\\/]/.test(value) &&
        !value.includes("::") &&
        !/^[A-Za-z]:/.test(value),
      "Use an entity ID returned by list_project_entities, not a directory or remote identifier.",
    );
  async function call<T extends object>(
    schema: z.ZodType<T>,
    run: (id: string) => Promise<ControlResult<T, string>>,
  ) {
    const context = deps.getSessionContext();
    if (!context?.sessionId?.trim())
      return errorPayload(
        "NO_SESSION_CONTEXT",
        "No trusted Cindy task context is available.",
      );
    if (context.remoteHostId || context.vendorOptions?.orcaRemoteLead)
      return errorPayload(
        "UNSUPPORTED_CAPABILITY",
        "Entity project queries are not connected for this remote execution context.",
      );
    const result = await run(context.sessionId);
    if (!result.ok) return errorPayload(result.errorCode, result.message);
    const projected = schema.safeParse(result);
    if (!projected.success)
      return errorPayload(
        "INTERNAL",
        "The host returned an invalid entity project response.",
      );
    return okPayload(projected.data as Record<string, unknown>);
  }
  registry.register({
    name: "list_project_entities",
    category: "control",
    inputShape: {},
    description:
      "Read all entity projects visible to the current trusted task on this host. Returns stable entity IDs, not project paths. Read-only: does not register directories, create tasks or grant membership. Separate from legacy list_projects. Remote execution contexts are unsupported.",
    handler: () =>
      call(z.object({ projects: z.array(project) }), (callerSessionId) =>
        deps.callbacks.list({ callerSessionId }),
      ),
  });
  registry.register({
    name: "get_project_entity",
    category: "control",
    inputShape: { project_id: projectId },
    description:
      "Read an authorized entity project and its work items by project_id from list_project_entities. This ID is not project_path or working_dir. Read-only; access is checked by the host for the calling task.",
    handler: ({ project_id }) =>
      call(detail, (callerSessionId) =>
        deps.callbacks.detail({ callerSessionId, projectId: project_id }),
      ),
  });
  registry.register({
    name: "get_project_progress",
    category: "control",
    inputShape: {
      project_id: projectId,
      before_event_id: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
    },
    description:
      "Read authorized project progress: all current items and one history page (up to 100 events). before_event_id pages only history; items remain complete. Preserve bindingRevision and unknown progress. Done confirms work progress, not independent acceptance or release. Does not start or follow up an execution.",
    handler: ({ project_id, before_event_id }) =>
      call(progress, (callerSessionId) =>
        deps.callbacks.progress({
          callerSessionId,
          projectId: project_id,
          ...(before_event_id === undefined
            ? {}
            : { beforeEventId: before_event_id }),
        }),
      ),
  });
}
