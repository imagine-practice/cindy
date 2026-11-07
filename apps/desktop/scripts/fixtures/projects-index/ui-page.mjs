import { assertProjectUiRules } from '../project-core/ui-rules.mjs';

export default {
  name: 'projects-index',
  entry: './projects-index-fixture.tsx',
  viewport: { width: 320, height: 840 },
  real: 'ProjectsPage + controller + fixed projectService + fixed NewProjectDialog; themed primitives, real Radix keyboard interactions.',
  notCovered:
    'Synthetic preload list/mutation receipts and auth/bot projection. No DB, real permissions, groups, routing, progress aggregation or deployment. Existing creatorMember locale dependency is not changed.',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: `export const useOptionalAuth=()=>({dataOwnerId:'creator',dataOwnerGeneration:1,user:{name:'Example creator'}});`,
    },
    'src/renderer/features/bots/botStore': { partial: 'export const useBotProfiles=()=>[];' },
  },
  cases: {
    default: {
      about:
        'Project cards, same names/different IDs, account/bot same ID, long goal, archived filtering and keyboard creation cancellation',
    },
    empty: { about: 'Actual authorized empty list' },
    error: { about: 'Read failure then explicit retry' },
    forbidden: { about: 'Project access denied' },
    'old-host': { about: 'Missing project bridge is not empty success' },
    loading: { about: 'Pending authority read does not show empty' },
  },
  async ready(page) {
    await page.getByRole('heading', { level: 1 }).waitFor();
  },
  async check(page, ui) {
    await assertProjectUiRules(page);
    const t = (k, v) => ui.t('ccAgent.projectCore.index.' + k, v);
    const newLabel = await ui.t('ccAgent.projectCore.newProject');
    const fresh = () => page.getByRole('button', { name: newLabel, exact: true }).first();
    if (ui.case === 'empty') {
      await page.getByText(await t('emptyTitle'), { exact: true }).waitFor();
      return;
    }
    if (ui.case === 'loading') {
      await page.getByText(await t('loading')).waitFor();
      return;
    }
    if (ui.case === 'forbidden' || ui.case === 'old-host') {
      await page
        .getByText(await t(ui.case === 'forbidden' ? 'forbidden' : 'hostUnavailable'))
        .waitFor();
      return;
    }
    if (ui.case === 'error') {
      await page.getByText(await t('loadFailed')).waitFor();
      await ui.capture('error');
      await page.getByRole('button', { name: await t('retry'), exact: true }).click();
    }
    const first = page.locator('button[data-project-id="p1"]');
    await first.waitFor();
    if ((await page.locator('button[data-project-id]').count()) !== 3)
      throw new Error('Active filter should show three authorized projects');
    await ui.capture('project-cards');
    await first.focus();
    await page.keyboard.press('Enter');
    if (JSON.stringify(await page.evaluate(() => window.__indexOpened)) !== JSON.stringify(['p1']))
      throw new Error('Keyboard activation lost project ID');
    await page.getByRole('textbox', { name: await t('searchLabel') }).fill('Long-project-name');
    if (ui.locale !== 'de') await page.locator('button[data-project-id="p-long"]').waitFor();
    await page.getByRole('textbox', { name: await t('searchLabel') }).fill('');
    const filter = page.getByRole('combobox', { name: await t('filterLabel') });
    await filter.click();
    await page.getByRole('option', { name: await t('archived'), exact: true }).click();
    await page.locator('button[data-project-id="p-archived"]').waitFor();
    await ui.capture('archived');
    await fresh().click();
    await page.getByRole('dialog').waitFor();
    await page
      .getByRole('textbox', { name: await ui.t('ccAgent.projectCore.form.name') })
      .fill('Cancelled fixture project');
    await page
      .getByRole('button', { name: await ui.t('ccAgent.projectCore.form.cancel'), exact: true })
      .click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(
      (el) => el === document.activeElement,
      await fresh().elementHandle(),
    );
    if ((await page.evaluate(() => window.__indexWrites)).length)
      throw new Error('Cancellation wrote a project');
  },
};
