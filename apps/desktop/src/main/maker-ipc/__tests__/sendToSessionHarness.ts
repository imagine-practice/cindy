/** Shared execution of register's actual send closures; inject host services only. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, vi } from 'vitest';
import { permissionModeOrAsk } from '@cindy/maker-shared/permission-mode';
import { AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION, TurnDispatchRejectedError, type SendOptions } from '@cindy/maker-core';
import { assertTaskActionCurrent, hasTaskActionAuthorization } from '../taskActionAuthorization.js';
import { restoreAutoReviewUserIntent } from '../autoReviewUserIntent.js';
import { verifiedOwnerRequestText } from '../../../shared/forwardedRequest.js';
import { createWireNoteMemory } from '../wireNoteMemory.js';
import { resolveSendToSessionCreateRoute } from '../sendToSessionExecutionConfig.js';
import type { GhostAgentTurnRunnerDeps } from '../ghostAgentTurnRunner.js';
import { installDesktopInteractionHandler } from '../interactionRouter.js';
import type { AgentInputCoordinator } from '../agent-input-coordinator.js';
import type { InteractionRequest, InteractionDecision } from '@cindy/maker-core';
import { bindTaskActionInput } from '../taskActionAuthorization.js';
import { HOST_ONLY_AGENT_PREFIX } from '../../../shared/agentInputQueue.js';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn.js';
const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(/\r\n?/g, '\n');

function botTaskDispatchSlice(): string {
  const slice = (startMarker: string, endMarker: string, from = 0): string => {
    const start = registerSource.indexOf(startMarker, from);
    expect(start, startMarker).toBeGreaterThanOrEqual(0);
    const end = registerSource.indexOf(endMarker, start);
    expect(end, endMarker).toBeGreaterThan(start);
    return registerSource.slice(start, end);
  };
  const lockReturn = 'return trackSendToSessionLockRun(targetSessionId, run, () => lockStage);';
  const sendToSessionInternal =
    slice('async function sendToSessionInternal(params: {', lockReturn) + `${lockReturn}\n}`;
  const sendWithBaseline = slice('async function sendUserMessageWithAwaitedGitBaseline(', '\n  /**\n   * 来源标签用的发送方身份快照');
  const dispatchBotSessionMessage = slice(
    'const dispatchBotSessionMessage = async (params: {',
    '\n  setBotInvitationWelcomeDispatch(dispatchBotSessionMessage);',
  );
  const groupDispatch = slice(
    '({ targetSessionId, message, persistedContent, autoReviewUserText, clientId, attachments, toolsDisabled, onQueued, onAccepted }) =>',
    ',\n    prepareAttachments:',
    registerSource.indexOf('const botGroupChatDeps: BotGroupChatServiceDeps = {'),
  );
  return ts.transpileModule(
    `${sendWithBaseline}
${sendToSessionInternal}
${dispatchBotSessionMessage}
// Host-originated input to a teammate task (cloud room, group delivery) resumes with its stored mode.
const delegationDispatch = (params) => dispatchBotSessionMessage({ ...params, resumeWithStoredPermissionMode: true });
const groupDispatch = ${groupDispatch};
return { delegationDispatch, groupDispatch, dispatchBotSessionMessage, sendToSessionInternal };`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
  ).outputText;
}

// 非严格模式的 with:生产片段里的自由标识符一律从 scope 解析。
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const loadBotTaskDispatch = new Function(
  'scope',
  `with (scope) { return (function () { ${botTaskDispatchSlice()} })(); }`,
) as (scope: object) => {
  sendToSessionInternal: (input: Record<string, unknown>) => ReturnType<GhostAgentTurnRunnerDeps['send']>;
  groupDispatch: (input: Record<string, unknown>) => Promise<{ ok: boolean; wakeKind?: string }>;
  dispatchBotSessionMessage: (input: Record<string, unknown>) => Promise<{ ok: boolean; wakeKind?: string }>;
  delegationDispatch: (
    input: Record<string, unknown>,
  ) => Promise<{ ok: boolean; wakeKind?: string }>;
};

export function botTaskDispatchHarness(
  rows: Record<string, { permissionMode: string | null; planModeEnabled: boolean }>,
  live: Record<string, object> = {},
  overrides: Record<string, unknown> = {},
) {
  const bootstrapped: Array<Record<string, unknown>> = [];
  const sentTo: Array<{ sessionId: string; planMode: unknown }> = [];
  const sendOptions: SendOptions[] = [];
  const readAutoReviewHistory = vi.fn(async () => [{
    clientId: 'old-owner-input', role: 'user' as const, content: 'You may deploy.',
    agentMeta: { delivery: 'turn', autoReviewUserText: 'You may deploy.' },
  }]);
  const noop = () => undefined;
  const asyncNoop = async () => undefined;
  const activity = new Map<string, number>();
  const touchSessionActivityInDb = vi.fn(async (id: string) => { activity.set(id, Date.now()); });
  const sendFor = (session: { id: string }) => async (
    _message: unknown,
    opts: SendOptions & { onAccepted?: () => Promise<void>; onDispatching?: () => void },
  ) => {
    sendOptions.push(opts);
    await opts.onAccepted?.();
    try { opts.onDispatching?.(); } catch (error) {
      if (error instanceof TurnDispatchRejectedError) return { accepted: false, reason: 'provider-rejected-before-dispatch' };
      throw error;
    }
    sentTo.push({ sessionId: session.id, planMode: opts.planMode });
    return { accepted: true };
  };
  for (const [id, session] of Object.entries(live)) {
    if (!('send' in session)) Object.assign(session, { send: sendFor({ id }) });
  }
  const dbChain = {
    from: () => dbChain,
    innerJoin: () => dbChain,
    where: () => dbChain,
    limit: async () => [],
  };
  const stubs: Record<string, unknown> = {
    touchSessionActivityInDb,
    assertCindyMakeSessionAvailable: noop,
    readSessionSource: asyncNoop,
    prepareUpstreamMergeTurn: noop,
    isCindyMakeWorktreePath: () => false,
    app: { getPath: () => '/fixture' },
    agentHandoffPending: { peek: asyncNoop },
    wireNoteMemory: createWireNoteMemory(),
    shouldPrependMobileClientPromptNote: () => false,
    noteChannelTurnSource: () => noop,
    channelTurnSourceFor: noop,
    beginTurnChangeSetAtDispatch: asyncNoop,
    clearPendingTurnChangeSets: noop,
    gitSnapshotCoordinator: null,
    deferredProductTurnFailureGate: { clearSession: noop },
    withCindyMakeProjectUse: (_root: string, _workdir: string, dispatch: () => Promise<unknown>) => dispatch(),
    assertTaskActionCurrent, hasTaskActionAuthorization, TurnDispatchRejectedError,
    AUTO_REVIEW_SOURCE_CONTENT, AUTO_REVIEW_USER_INTENT, AUTO_REVIEW_DELEGATED_CONTINUATION,
    restoreAutoReviewUserIntent, readAutoReviewHistory, verifiedOwnerRequestText,
    maker: {
      getSession: (id: string) => live[id],
      getSessionMeta: async (id: string) => ({
        id,
        agentKind: 'claude-code',
        workDir: `/tmp/fixture/${id}`,
        model: 'claude-opus-fixture',
        sdkSessionId: `sdk-${id}`,
      }),
    },
    getSessionRowSnapshot: async (id: string) =>
      rows[id]
        ? { status: 'active', title: id, userSendAt: null, providerId: 'fixture-provider', ...rows[id] }
        : null,
    getDbClient: () => ({ drizzle: { select: () => dbChain } }),
    messages: {},
    sessions: {},
    // 云端伙伴副本门:合成库里没有关联行,目标不是被接管的副本。
    botSessionLinks: {},
    isShadowedCompanionSession: () => false,
    isCompanionShadowed: () => false,
    SHADOWED_COMPANION_INPUT_MESSAGE: 'shadowed',
    and: noop,
    eq: noop,
    log: { info: noop, warn: noop, debug: noop, error: noop },
    createId: () => 'generated-client-id',
    permissionModeOrAsk,
    readSenderIdentity: async () => ({}),
    sessionQueueOriginForDispatcher: noop,
    extractPlainText: (value: unknown) => String(value ?? ''),
    assertReviewExternalInputAllowed: asyncNoop,
    syncBotLanePermission: asyncNoop,
    reconcileBotModelRoute: asyncNoop,
    scheduledModelScope: { restore: asyncNoop },
    refreshBotCapabilityEpochBeforeSend: asyncNoop,
    assertSessionNotRestarting: noop,
    sendToSessionLocks: new Map(),
    waitForSendToSessionLock: async () => undefined,
    trackSendToSessionLockRun: (_id: string, run: Promise<unknown>) => run,
    inputCoordinator: { ensureQueueRestored: asyncNoop, shouldQueueNewTurn: () => false },
    enqueueSendToSessionMessage: vi.fn(asyncNoop),
    BOT_GROUP_CLIENT_ID_PREFIX: 'bot-group:',
    agentSwitchPending: new Map(),
    notifyAgentIslandUserPrompt: noop,
    dispatchAgentIslandUserPrompt: noop,
    commitAgentIslandUserPrompt: noop,
    rollbackAgentIslandUserPrompt: noop,
    createDbMessage: asyncNoop,
    runAcceptedCallback: async (callback?: () => unknown) => {
      await callback?.();
    },
    prepareUnhealthySessionForSend: vi.fn(async () => false),
    taskCompletionDeliveryForOwner: () => null,
    buildCreateOptsWithStderr: (opts: Record<string, unknown>) => ({ ...opts }),
    synthesizeOrcaVendorOptionsFromDb: asyncNoop,
    readSessionExtraDirsFromDb: async () => [],
    readSessionWritableDirsFromDb: async () => [],
    ensureRemoteReadyForSessionStart: asyncNoop,
    bootstrapSession: async (opts: Record<string, unknown>) => {
      bootstrapped.push(opts);
      return { session: { id: opts.id, agentKind: opts.agentKind, send: sendFor({ id: opts.id as string }) } };
    },
    markOrcaRoleIfNeeded: asyncNoop,
    assertDesktopSendDispatched: noop,
    isSessionRunningError: () => false,
    GroupToolAuthorizationError: class extends Error {},
    AcceptedCallbackDispatchCancelled: class extends Error {},
    // create 分支的位置与执行配置走真实解析；不指定位置与配置时不读任何供应商。
    resolveSendToSessionCreateRoute,
    getSelfDeviceId: () => 'self-device',
  };
  Object.assign(stubs, overrides);
  const scope = new Proxy(stubs, {
    // 自己声明的桩优先;JS 内建对象照常解析;其余自由标识符一读就失败。
    has: (target, key) => key in target || !(key in globalThis),
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return target[key as string];
      throw new ReferenceError(`unstubbed dependency of the production slice: ${String(key)}`);
    },
  });
  return { ...loadBotTaskDispatch(scope), scope: stubs, bootstrapped, sentTo, sendOptions, readAutoReviewHistory, activity, touchSessionActivityInDb };
}

// Execute the same queue builder, native Desktop interaction registration,
// public pending reader and owner host registration as the running application.
// Native Session/DB/OS services are controlled; IDs and pending entries are NOT
// supplied by a hand-filled active-input or confirmation projection.
const registerAst=ts.createSourceFile('register.ts',registerSource,ts.ScriptTarget.Latest,true);
const authorizationSource=readFileSync(resolve(__dirname,'../botAuthorizationService.ts'),'utf8');
const authorizationAst=ts.createSourceFile('botAuthorizationService.ts',authorizationSource,ts.ScriptTarget.Latest,true);
function functionText(ast:ts.SourceFile,name:string):string {
  let found:ts.FunctionDeclaration|undefined;
  let initializer:ts.Expression|undefined;
  const visit=(node:ts.Node)=>{if(ts.isFunctionDeclaration(node)&&node.name?.text===name)found=node;
    else if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)initializer=node.initializer;
    else ts.forEachChild(node,visit);};
  visit(ast);if(!found){if(initializer)return `const ${name}=${initializer.getText(ast)};`;throw Error(`Production function missing: ${name}`);}
  return found.getText(ast).replace(/^export /,'');
}
const hostStart=registerSource.indexOf('  setOwnerTurnDispatch(\n');
const hostEnd=registerSource.indexOf('  registerProjectWorkItemExecutionIpc();',hostStart);
if(hostStart<0||hostEnd<hostStart)throw Error('Production owner host registration missing');
const nativeHostSource=[
  ...['clearPendingInteraction','bindSharedPermission','cancelPendingInteraction','resolvePendingInteraction',
    'dismissRendererInteraction','persistInteractionDecision','getPendingInteractionsForSession',
    'installDesktopInteractionListener','enqueueSendToSessionMessage','buildSessionControlInputItem','runtimeSelectionRequiresModelWindowConfirmation']
    .map(name=>functionText(registerAst,name)),
  ...['resolveBotAuthorizationDelivery','commitBotAuthorizationInput'].map(name=>functionText(authorizationAst,name)),
  registerSource.slice(hostStart,hostEnd),
  'return {enqueueSendToSessionMessage,buildSessionControlInputItem,resolveBotAuthorizationDelivery,commitBotAuthorizationInput,installDesktopInteractionListener,getPendingInteractionsForSession};',
].join('\n');
const loadNativeHost=new Function('scope',`with(scope){return (function(){${ts.transpileModule(nativeHostSource,
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText}})();}`);

export function wireNativeWorkItemHost(h:ReturnType<typeof botTaskDispatchHarness>, coordinator:AgentInputCoordinator,
  setOwnerTurnDispatch:(value:import('../ownerTurnDispatch').OwnerTurnHost)=>void, overrides:Record<string,unknown>) {
  const noop=()=>undefined;
  const emptyBridge={pendingSnapshots:()=>[]};
  Object.assign(h.scope,{
    inputCoordinator:coordinator,agentInputCoordinatorHolder:coordinator,
    dispatchBotSessionMessage:h.dispatchBotSessionMessage,setOwnerTurnDispatch,
    pendingInteractionResolvers:new Map(),installDesktopInteractionHandler,bindTaskActionInput,
    HOST_ONLY_AGENT_PREFIX,UI_ACTION_TRIGGER_PREFIX,
    shouldNotifyAgentIslandForSession:()=>false,flushAssistantBlock:noop,onInteractionMessage:noop,
    redactToolInputForUntrustedBoundary:(_tool:string,input:unknown)=>input,
    schedulePendingPermissionTimeout:noop,handleAgentIslandInteractionAfterBroadcast:noop,
    handleAgentIslandInteractionDismissed:noop,broadcastToAllWindows:noop,
    MAKER_PUSH:{INTERACTION_REQUEST:'interaction-request',INTERACTION_DISMISSED:'interaction-dismissed'},
    orcaInterAgentDispatcher:{registerQueuedOrcaInterAgentAcceptedCallback:noop},
    goalAskAnswerObserver:null,getInputHandoffService:()=>null,
    mcpSetupBridge:emptyBridge,issueConfirmBridge:emptyBridge,renameSessionsConfirmBridge:emptyBridge,
    taskActionConfirmBridge:emptyBridge,orcaWorkerPermissionConfirmBridge:emptyBridge,
    ghostGrantConfirmBridge:emptyBridge,ghostSetupInteractionBridge:emptyBridge,
  },overrides);
  const scope=new Proxy(h.scope,{
    has:(target,key)=>key in target || !(key in globalThis),
    get:(target,key)=>{if(key===Symbol.unscopables)return undefined;if(key in target)return target[key as string];
      throw new ReferenceError(`Unstubbed native host dependency: ${String(key)}`);},
  });
  const loaded=loadNativeHost(scope) as {
    enqueueSendToSessionMessage:unknown;buildSessionControlInputItem:unknown;
    resolveBotAuthorizationDelivery:unknown;commitBotAuthorizationInput:unknown;
    installDesktopInteractionListener:(session:{id:string;setInteractionListener:(listener:((request:InteractionRequest)=>Promise<InteractionDecision>)|null)=>void})=>void;
    getPendingInteractionsForSession:(sessionId:string)=>{request:InteractionRequest}[];
  };
  Object.assign(h.scope,loaded);
  return loaded;
}
