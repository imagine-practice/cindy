// @vitest-environment jsdom
/** T2 integration: actual page/form/service -> production preload adapter -> S handlers ->
 * actual dispatcher and real official-migration SQLite. Controlled native host/auth; no real account/model.
 * tier: integration (real full migration chain + native SQLite + compiled production preload adapter).
 * Kept separate from the frozen E1 unit suite: it needs the main dispatcher and durable state.
 * Standalone: 8/8; timings and the unmet ordinary-unit 5s budget are recorded in T2 checks.json.
 * Gap: form callbacks alone cannot prove revisions, persistence, receipt replay or rereads.
 * Minimum failures: stale revision or lost reply after committed write. Migrate once, no real waits/resets.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, afterEach, afterAll, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { ProjectDetailPage } from '../ProjectDetailPage';
import { createBetterSqliteDatabase } from '../../../../main/localDb/betterSqliteFactory';
import { runMigrationReplay } from '../../../../main/localDb/migrationRunner';
import { dispatch } from '../../../../main/localDb/worker/dispatcher';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../../main/localDb/client/current';
import type { DbClient } from '../../../../main/localDb/client/DbClient';
import { registerProjectProgressIpc } from '../../../../main/localDb/ipc/projectProgress';
import type { WorkItemProgressIntent } from '../../../../shared/workItemProgress';
const h = vi.hoisted(() => ({ route: { projectId: 'p' }, user: 'owner', generation: 1, changed: undefined as undefined | (() => void),
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(), navigate: vi.fn(), tap: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (key: string, fn: (...args: unknown[]) => Promise<unknown>) => h.handlers.set(key, fn) }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../../../main/security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: vi.fn(), isTrustedAppRendererWindow: () => true }));
vi.mock('../../../../main/device-link/broadcast-tap', () => ({ captureDataOwnerBroadcastScope: () => ({ generation: h.generation }),
  isDataOwnerBroadcastScopeCurrent: (scope: { generation: number }) => scope.generation === h.generation,
  tapWindowBroadcast: (...args: unknown[]) => { h.tap(...args); h.changed?.(); } }));
vi.mock('../../../../main/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('react-router-dom', () => ({ useParams: () => h.route, useNavigate: () => h.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: h.user, dataOwnerGeneration: h.generation }), useOptionalDataOwnerGeneration: () => h.generation }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.generation, isDataOwnerGenerationCurrent: (owner: number) => owner === h.generation }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../projectLabels', () => ({ useProjectSubjectLabel: () => (s: { id: string }) => s.id, projectSubjectAvatar: () => 'X', projectSubjectVisual: (subject: { kind: 'account' | 'bot' }, name: string) => ({ kind: subject.kind, name }) }));
// 页面里的转交负责人/移除成员要二次确认：这个 provider 在应用树外层，测试里给一个恒定的实现。
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: async () => false }),
  useOptionalConfirmDialog: () => ({ confirm: async () => false }) }));
vi.mock('@/components/ui/select', () => ({ Select: (props: { label: string; value: string; disabled?: boolean; options: { value: string; label: string; disabled?: boolean }[]; onValueChange(value: string): void }) =>
  <select aria-label={props.label} value={props.value} disabled={props.disabled} onChange={event => props.onValueChange(event.target.value)}>
    {props.options.map(o => <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>)}
  </select> }));
vi.mock('../projectService', () => ({ readProjectDetail: async (id: string) => ({ project: { id, name: `Project ${id}`, goal: '', ownerId: 'owner', members: [], status: 'active', createdAt: '2026-11-05', taskCount: 1, dirs: [] }, workItems: [] }),
  onProjectsChanged: (fn: () => void) => { h.changed = fn; return () => { if (h.changed === fn) h.changed = undefined; }; },
  addProjectMember: vi.fn(), removeProjectMember: vi.fn(), renameProject: vi.fn(), setSessionAssignee: vi.fn(), transferProjectOwner: vi.fn() }));
let db: Database.Database; let dir: string; let client: DbClient; let bridge: ReturnType<typeof vi.fn>;
const edit = (key: string) => `ccAgent.projectCore.progressEdit.${key}`;
function pending() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
const preload = readFileSync(path.resolve(__dirname, '../../../../preload/preload.ts'), 'utf8');
const start = preload.indexOf('    projectProgress: {'), end = preload.indexOf('    materials: {', start);
// Compile the production adapter in Node's realm (esbuild cannot run inside jsdom's typed-array realm).
const compiled = execFileSync(process.execPath, ['-e', `process.stdout.write(require('esbuild').transformSync(require('node:fs').readFileSync(0,'utf8'),{loader:'ts',target:'es2022'}).code)`],
  { input: `const bridge = {${preload.slice(start, end)}};`, encoding: 'utf8', windowsHide: true });
const adapter = new Function('ipcRenderer', `${compiled}; return bridge.projectProgress;`)({ invoke: (key: string, request: unknown) => h.handlers.get(key)!({}, request) });
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-T2-')); db = createBetterSqliteDatabase(path.join(dir, 'fixture.db'));
  const desktop = path.resolve(__dirname, '../../../../..');
  db.loadExtension(path.join(desktop, 'native/sqlite-vec', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'vec0.dll' : 'vec0.dylib'));
  runMigrationReplay(db, { drizzleDir: path.join(desktop, 'drizzle') }); registerProjectProgressIpc();
});
beforeEach(() => {
  vi.clearAllMocks(); h.user = 'owner'; h.generation++; h.route = { projectId: 'p' };
  db.exec(`DELETE FROM work_item_progress; DELETE FROM work_item_progress_events; DELETE FROM project_members; DELETE FROM projects; DELETE FROM sessions;
    INSERT INTO projects(id,name,owner_id,status,created_at,updated_at) VALUES ('p','P','owner','active',1,1),('q','Q','owner','active',1,1);
    INSERT INTO project_members VALUES ('p','account','owner','owner',1),('p','account','member','member',1),('p','account','other','member',1),('q','account','owner','owner',1);
    INSERT INTO sessions(id,title,status,project_id,project_binding_revision,created_at,updated_at) VALUES ('s','Task','active','p',7,1,1),('s2','Other task','active','q',4,1,1);`);
  bridge = vi.fn(async (name: string, args: unknown) => dispatch('tx', { name, args }, db));
  client = { tx: bridge } as unknown as DbClient; setCurrentDbClient(client, h.user);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { projectProgress: adapter } } });
});
afterEach(() => { cleanup(); clearCurrentDbClient(); }); afterAll(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
async function open(title = 'Task') { fireEvent.click(await screen.findByRole('button', { name: `${edit('title')} — ${title}` })); return screen.findByRole('dialog'); }
function choose(status: string) { fireEvent.change(within(screen.getByRole('dialog')).getByRole('combobox'), { target: { value: status } }); }
function fill(field: string, value: string) { fireEvent.change(within(screen.getByRole('dialog')).getByLabelText(edit(field), { exact: false }), { target: { value } }); }
function save(label = 'save') { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: edit(label) })); }
const eventCount = () => (db.prepare('SELECT COUNT(*) AS n FROM work_item_progress_events').get() as { n: number }).n;
const intents = () => bridge.mock.calls.filter(([name]) => name === 'workItemProgress.execute').map(([,args]) => (args as { intent: WorkItemProgressIntent }).intent);
async function step(status: string, fields: Record<string,string> = {}) { await open(); choose(status); for (const [field,value] of Object.entries(fields)) fill(field,value);
  if (status === 'done') fireEvent.click(within(screen.getByRole('dialog')).getByRole('checkbox')); save();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); await screen.findByRole('button', { name: `${edit('title')} — Task` }); }

it('persists the full state flow through page/service/preload/S and rereads canonical results with real epoch/revisions', async () => {
  render(<ProjectDetailPage />);
  await step('todo'); await step('doing'); await step('blocked', { reason: 'Waiting', condition: 'Ready' });
  await step('doing', { resolution: 'Ready now' }); await step('review'); await step('done', { note: 'Work progress confirmed' });
  expect(eventCount()).toBe(6);
  expect(db.prepare('SELECT status,revision,binding_revision,completion_event_id FROM work_item_progress WHERE session_id=?').get('s'))
    .toEqual({ status: 'done', revision: 6, binding_revision: 7, completion_event_id: expect.any(Number) });
  expect(intents().map(value => value.expectedRevision)).toEqual([0,1,2,3,4,5]);
  expect(intents().every(value => value.expectedBindingRevision === 7 && !('actor' in value))).toBe(true);
});
it('uses capability hints without granting a plain member done authority', async () => {
  h.user = 'member'; setCurrentDbClient(client, h.user); render(<ProjectDetailPage />); await open();
  expect(within(screen.getByRole('dialog')).queryByRole('option', { name: edit('status.done') })).toBeNull();
  await expect(adapter.update({ projectId:'p',sessionId:'s',expectedRevision:0,expectedBindingRevision:7,requestId:'forged',to:'done',completionNote:'No owner' })).rejects.toMatchObject({ code:'FORBIDDEN' });
  expect(eventCount()).toBe(0);
});
it('replays the original intent/requestId after an actually committed write loses its receipt', async () => {
  render(<ProjectDetailPage />); await open(); choose('doing');
  bridge.mockImplementationOnce(async (name,args) => { await dispatch('tx',{name,args},db); throw Object.assign(new Error('lost receipt'),{code:'DB_TRANSPORT_OUTCOME_UNKNOWN'}); });
  save(); await screen.findByText(edit('error.uncertain')); expect(eventCount()).toBe(1);
  save('retry'); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(intents()).toHaveLength(2); expect(intents()[1]).toEqual(intents()[0]); expect(eventCount()).toBe(1);
});
it('locks a real revision conflict until the user refreshes and opens a fresh snapshot', async () => {
  render(<ProjectDetailPage />); await open(); choose('doing');
  await dispatch('tx',{name:'workItemProgress.execute',args:{intent:{projectId:'p',sessionId:'s',expectedRevision:0,expectedBindingRevision:7,requestId:'external',to:'doing'},context:{actor:{kind:'account',id:'owner'},now:1}}},db);
  save(); await screen.findByText(edit('error.REVISION_CONFLICT'));
  expect(within(screen.getByRole('dialog')).getByRole('button',{name:edit('save')})).toHaveProperty('disabled',true);
  expect(intents()).toHaveLength(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:edit('refresh')}));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); await open(); choose('blocked'); fill('reason','Now blocked'); fill('condition','New input'); save();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull()); expect(intents()[1].expectedRevision).toBe(1); expect(eventCount()).toBe(2);
});
it('closing a busy dialog does not cancel an already committed request and still refreshes the current page', async () => {
  const hold=pending(); render(<ProjectDetailPage />); await open(); choose('doing');
  bridge.mockImplementationOnce(async(name,args)=>{const result=await dispatch('tx',{name,args},db);await hold.promise;return result;});
  save(); await screen.findByText(edit('inFlight')); expect(eventCount()).toBe(1);
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:edit('close')})); expect(screen.queryByRole('dialog')).toBeNull();
  await act(async()=>hold.resolve()); await screen.findByRole('button',{name:/progress.doing.*1/}); expect(eventCount()).toBe(1);
});
it.each(['route','owner'])('ignores old %s write receipts without closing or resetting the newer dialog', async change => {
  const hold=pending(); const page=render(<ProjectDetailPage />); await open(); choose('doing');
  bridge.mockImplementationOnce(async(name,args)=>{const result=await dispatch('tx',{name,args},db);await hold.promise;return result;});
  save(); await screen.findByText(edit('inFlight'));
  if(change==='route') h.route={projectId:'q'}; else {h.user='other';h.generation++;setCurrentDbClient(client,h.user);}
  page.rerender(<ProjectDetailPage />); await open(change==='route'?'Other task':'Task'); choose('blocked'); fill('reason','New scope draft'); fill('condition','Keep');
  await act(async()=>hold.resolve()); expect(within(screen.getByRole('dialog')).getByLabelText(edit('reason'),{exact:false})).toHaveProperty('value','New scope draft');
  expect(screen.queryByText(edit('error.uncertain'))).toBeNull(); expect(eventCount()).toBe(1);
});

it('clears the page after membership is revoked between read and the actual write transaction', async () => {
  h.user = 'member'; setCurrentDbClient(client, h.user);
  render(<ProjectDetailPage />); await open(); choose('doing');
  db.prepare("DELETE FROM project_members WHERE project_id='p' AND subject_id='member'").run();
  save(); await screen.findByRole('heading', { name: 'ccAgent.projectCore.progress.forbidden' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Project p')).toBeNull();
  expect(eventCount()).toBe(0); expect(h.tap).not.toHaveBeenCalled();
});
