// @vitest-environment jsdom
// Unit behavioral regression: execute actual route binding/memo and local create callback ASTs
// with real React hooks. Existing submission tests extract the same production callbacks.
// Avoids mounting model/provider/device trees unrelated to project binding. No source-string assertions.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { URL as NodeURL } from 'node:url';
import { useMemo, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const source = ts.createSourceFile(
  'NewMakerDraftRoute.tsx',
  readFileSync(new NodeURL('../NewMakerDraftRoute.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const route = source.statements.find(
  (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'NewMakerDraftRoute',
) as ts.FunctionDeclaration;
const body = route.body!;
const indexOf = (name: string) =>
  body.statements.findIndex(
    (s) =>
      ts.isVariableStatement(s) &&
      s.declarationList.declarations.some((d) => d.name.getText(source) === name),
  );
const binding = body.statements
  .slice(indexOf('location') + 1, indexOf('navigate'))
  .map((s) => s.getText(source))
  .join('\n');
const memo = (
  body.statements[indexOf('provisionalDraftArgs')] as ts.VariableStatement
).declarationList.declarations[0].initializer!.getText(source);
function compile(code: string) {
  return new Function(
    'scope',
    ts.transpileModule('with(scope){' + code + '}', {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
  ) as (scope: Record<string, unknown>) => unknown;
}
const actualBinding = compile(binding + ';return {boundProjectId,setBoundProjectId};');
const actualMemo = compile('return (' + memo + ');');
const base = {
  useMemo,
  useState,
  isDeviceLinkDraft: false,
  usesDeviceCatalog: false,
  wtEnabled: false,
  wtConfirmedIneligible: false,
  effectiveWorkingDir: '/same-dir',
  persistedAgentKind: 'cc',
  draftInitialModel: 'model',
  draftInitialEffort: 'high',
  chatInitialPermissionMode: 'auto',
  effectiveFastMode: false,
  effectivePlanMode: false,
  effectiveRemoteHostId: null,
  effectiveAgentDeviceId: null,
  effectiveExtraDirs: [],
  effectiveWritableDirs: [],
  chatInitialProviderId: null,
  localDraftSessionIdRef: { current: 'draft-id' },
};
afterEach(cleanup);
function Probe({
  projectId,
  routeKey = 'route',
  routeProject = 'p1',
}: {
  projectId?: string | null;
  routeKey?: string;
  routeProject?: string | null;
}) {
  const bound = actualBinding({
    ...base,
    location: { key: routeKey, state: { projectId: routeProject } },
    dataOwnerId: 'owner',
  }) as { boundProjectId: string | null; setBoundProjectId: (id: string | null) => void };
  const args = actualMemo({
    ...base,
    boundProjectId: projectId === undefined ? bound.boundProjectId : projectId,
  }) as { projectId?: string; workspaceKind: string };
  const [text, setText] = useState('keep this draft');
  return (
    <>
      <span data-testid="binding">{bound.boundProjectId ?? 'none'}</span>
      <output>{JSON.stringify(args)}</output>
      <input aria-label="draft" value={text} onChange={(e) => setText(e.target.value)} />
      <button onClick={() => bound.setBoundProjectId('p2')}>select p2</button>
    </>
  );
}
it('actual memo follows p1 -> p2 -> null -> p2 even when the directory is unchanged', () => {
  const view = render(<Probe projectId="p1" />);
  expect(screen.getByRole('status').textContent).toContain('"projectId":"p1"');
  view.rerender(<Probe projectId="p2" />);
  expect(screen.getByRole('status').textContent).toContain('"projectId":"p2"');
  view.rerender(<Probe projectId={null} />);
  expect(JSON.parse(screen.getByRole('status').textContent!).projectId).toBeUndefined();
  view.rerender(<Probe projectId="p2" />);
  expect(JSON.parse(screen.getByRole('status').textContent!).projectId).toBe('p2');
});
it('actual route binding initializes then follows selection and new route project without remounting the draft', () => {
  const view = render(<Probe />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'edited draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'select p2' }));
  expect(JSON.parse(screen.getByRole('status').textContent!).projectId).toBe('p2');
  view.rerender(<Probe routeKey="next" routeProject={null} />);
  expect(JSON.parse(screen.getByRole('status').textContent!).projectId).toBeUndefined();
  expect(input.value).toBe('edited draft');
  view.rerender(<Probe routeKey="third" routeProject="p3" />);
  expect(JSON.parse(screen.getByRole('status').textContent!).projectId).toBe('p3');
  expect(screen.getByRole('textbox')).toBe(input);
});

it('a new route project replaces the binding state itself without remounting the composer', () => {
  const view = render(<Probe />);
  const input = screen.getByRole('textbox');
  view.rerender(<Probe routeKey="another" routeProject="p3" />);
  expect(screen.getByTestId('binding').textContent).toBe('p3');
  expect(screen.getByRole('textbox')).toBe(input);
});

it('an in-flight page opener follows the latest project before runtime seeding and prewarm', async () => {
  const decl = (body.statements[indexOf('openProvisionalDraftTask')] as ts.VariableStatement)
    .declarationList.declarations[0];
  const callback = (decl.initializer as ts.CallExpression).arguments[0].getText(source);
  const a = { id: 'draft', projectId: 'p1', model: 'm', effort: '', permissionMode: 'auto' };
  const b = { ...a, projectId: 'p2' };
  const latest = { current: a };
  let release!: (session: unknown) => void;
  const ensure = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ id: 'draft', workingDir: '/b' });
  const runtime = vi.fn();
  const prewarm = vi.fn();
  const scope: Record<string, unknown> = {
    provisionalDraftArgsRef: latest,
    canOpenProvisionalDraftTask: () => true,
    ensureProvisionalDraftTask: ensure,
    provisionalDraftTaskId: () => 'draft',
    provisionalDraftArgsKey: (v: typeof a) => v.projectId,
    provisionalDraftTaskGeneration: () => 1,
    provisionalSeededKeyRef: { current: null },
    makerChatStore: { setSessionRuntime: runtime, prewarmSession: prewarm },
    dbToMakerAgentKind: () => 'cc',
    refreshProvisionalTitle: () => {},
    getComposerDraftPresence: () => true,
    NEW_MAKER_DRAFT_KEY: 'draft',
    armProvisionalEmptyCheck: () => {},
    sendInFlightRef: { current: false },
    discardProvisionalDraftTask: vi.fn(),
  };
  const open = compile('return (' + callback + ');')(scope) as () => void;
  scope.openProvisionalDraftTask = open;
  open();
  latest.current = b;
  release({ id: 'draft', workingDir: '/a' });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(ensure.mock.calls.map(([v]) => v.projectId)).toEqual(['p1', 'p2']);
  expect(prewarm.mock.calls.map((v) => v[4])).toEqual(['/b']);
  expect(runtime).toHaveBeenCalledTimes(1);
});

it('the SSH-local session create payload keeps the selected local project without changing remote protocol', () => {
  const decl = (body.statements[indexOf('handleRemoteProjectAdded')] as ts.VariableStatement)
    .declarationList.declarations[0];
  let payload: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'createSession')
      payload = node.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(decl);
  if (!payload) throw new Error('SSH local create missing');
  const actual = compile('return (' + payload.getText(source) + ');');
  const scope = {
    draftVendor: 'cc',
    target: { path: '/ssh/repo', hostId: 'ssh-host' },
    chatInitialPermissionMode: 'auto',
    sshModel: 'm',
    sshEffort: 'high',
    sshFastMode: false,
    effectivePlanMode: false,
    sshProviderId: null,
    boundProjectId: 'p2',
  };
  expect(actual(scope)).toMatchObject({
    projectId: 'p2',
    remoteHostId: 'ssh-host',
    workspaceKind: 'project',
  });
  expect(actual({ ...scope, boundProjectId: null })).not.toHaveProperty('projectId');
});
