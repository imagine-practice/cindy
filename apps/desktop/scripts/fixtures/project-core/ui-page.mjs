/**
 * 项目内核 M1（实体项目）界面场景。
 *
 * 只替换 main 的 IPC 投影：分组走真实 `groupSessions`，详情页走真实路由与组件。
 * 成员/负责人/指派的规则校验在服务层，见
 * `apps/desktop/src/main/localDb/__tests__/projects.test.ts`。
 */
export default {
  name: 'project-core',
  entry: './project-core-fixture.tsx',
  viewport: { width: 1040, height: 760 },
  real:
    'EntityProjectsSection + groupSessions (entity projects bound tasks), ProjectDetailPage (overview/members/work items), NewProjectDialog, ProjectBindingSelect',
  notCovered:
    'Main-process project service rules (covered by unit tests), bot list hydration for the add-member picker, account display name (renderer resolves it from auth; the fixture supplies it), and the sidebar coexistence with ProjectsSection directory groups.',
  stubs: {
    // 会话行只读 worktree 徽标；单页环境没有 worktree 服务。
    'src/renderer/contexts/WorktreeContext': {
      partial: `export const useWorktreeForSession = () => null;
export const useWorktrees = () => ({});
export const useReportWorktreeLiveness = () => () => undefined;
export const useObservedWorktreeForSession = () => null;
export const useRefreshObservedWorktree = () => async () => undefined;
export const useRefreshWorktreeForSession = () => async () => undefined;`,
    },
    // 单页环境不启动认证；会话行与项目页只读当前账号身份（id + 昵称）。
    'src/renderer/contexts/AuthContext': {
      partial: `const fixtureAuth = { user: { id: 'acc-1', name: 'Chris', avatar: null, email: null, defaultModel: 'claude-sonnet-4-6', defaultEffort: 'high', membershipKind: 'personal', membershipRole: 'owner', orgId: null, orgName: null, orgSlug: null, orgLogoUrl: null, passportId: 'fixture' }, mode: 'local', dataOwnerId: 'acc-1', dataOwnerRecoveryEpoch: 0, dataOwnerGeneration: 1, canEnterApp: true, isAuthenticated: true, isCanary: false, isInitializing: false, deviceId: 'fixture-device' };
export const useAuth = () => fixtureAuth;
export const useOptionalAuth = () => fixtureAuth;
export const useOptionalDataOwnerGeneration = () => fixtureAuth.dataOwnerGeneration;`,
    },
  },
  cases: {
    default: { about: 'Entity projects with bound tasks, an empty project and the new-project entry' },
    sidebar: { about: 'Entity projects with bound tasks, an empty project and the new-project entry' },
    metadata: { viewport: { width: 320, height: 850 }, about: 'Real detail/edit dialog/service, synthetic metadata backend; name save and keyboard focus' },
    'metadata-wide': { viewport: { width: 390, height: 850 }, about: 'Real detail/edit dialog/service, synthetic metadata backend; goal clear' },
    detail: { about: 'Project detail: goal, members with the owner marked, work items with assignee' },
    create: { about: 'New project dialog: name, goal, owner defaulted to the current account, member multi-select' },
    binding: { about: 'New task project selector (归属项目) with an existing project selected' },
  },
  async ready(page) {
    // 每个场景都有可交互控件；等第一个按钮/输入框出现即为就绪。
    await page
      .getByRole('button')
      .or(page.getByRole('textbox'))
      .or(page.getByRole('combobox'))
      .first()
      .waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('metadata')) {
      const key = name => ui.t('ccAgent.projectCore.metadataEdit.' + name);
      const trigger = page.getByRole('button', { name: await key('title'), exact: true });
      await trigger.waitFor();
      await ui.capture('metadata-entry');
      await trigger.click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      const name = dialog.locator('input'), goal = dialog.locator('textarea');
      if (!(await name.evaluate(el => el === document.activeElement))) throw Error('Metadata name not focused');
      await ui.capture('metadata-editor');
      if (ui.case === 'metadata') await name.fill('客户端布局验证 · 名称编辑');
      else await goal.fill('');
      await dialog.getByRole('button', { name: await key('save'), exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      if (ui.case === 'metadata') await page.getByRole('heading', { name: '客户端布局验证 · 名称编辑', exact: true }).waitFor();
      else await page.getByText(await ui.t('ccAgent.projectCore.detail.noGoal'), { exact: true }).waitFor();
      await page.waitForFunction(() => document.activeElement?.tagName === 'BUTTON');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      if (overflow) throw Error('Metadata page overflows viewport');
      await ui.capture('metadata-saved');
      return;
    }
    if (ui.case === 'detail') {
      await page.getByRole('button', { name: await ui.t('ccAgent.projectCore.detail.newTask'), exact: true }).waitFor();
    }
    if (ui.case === 'sidebar') {
      await page.getByRole('button', { name: await ui.t('ccAgent.projectCore.newProject'), exact: true }).waitFor();
    }
    if (ui.case === 'binding') {
      await page.getByRole('combobox').first().waitFor();
    }
    if (ui.case === 'create') {
      await page.getByRole('textbox').first().waitFor();
    }
  },
};
