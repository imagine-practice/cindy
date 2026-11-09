export default {
  name: 'project-metadata-editor',
  entry: './project-metadata-editor-fixture.tsx',
  viewport: { width: 320, height: 850 },
  real: 'EditProjectDialog, real Radix Dialog, FormField/Input/Textarea/Button and theme; exact callback patch.',
  notCovered:
    'Synthetic project and save callback; no ProjectDetailPage, service/Host/DB/permissions integration or real account/model.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration=()=>1;',
  },
  cases: {
    default: { about: 'Long name/goal, full outside click, keyboard Save and focus return' },
    clear: { about: 'Goal clearing emits explicit null only' },
    error: { about: 'Rejected save keeps draft and explicit retry' },
    busy: { about: 'Pending write blocks dismissal' },
    readonly: { about: 'Read-only hint, no save' },
    scope: { about: 'Old write success cannot close replacement view' },
  },
  async ready(page) {
    await page.getByRole('button').click();
    await page.getByRole('dialog').waitFor();
  },
  async check(page, ui) {
    const t = (k) => ui.t('ccAgent.projectCore.metadataEdit.' + k);
    const button = async (k) => page.getByRole('button', { name: await t(k), exact: true });
    const name = page.locator('input');
    const goal = page.locator('textarea');
    if (ui.case === 'readonly') {
      if (await (await button('save')).isEnabled()) throw Error('Read-only Save enabled');
      await ui.capture('readonly');
      return;
    }
    if (!(await name.evaluate((el) => document.activeElement === el)))
      throw Error('Name not focused');
    // Full mouse down/up/click through Playwright; the deferred outside listener must not dismiss.
    await page.mouse.click(4, 4);
    if (!(await page.getByRole('dialog').count())) throw Error('Scrim dismissed dialog');
    if (ui.case === 'clear') await goal.fill('');
    else await name.fill('  Updated project  ');
    if (ui.case === 'default') {
      await name.focus();
      await page.keyboard.press('Tab');
      if (!(await goal.evaluate((el) => document.activeElement === el)))
        throw Error('Goal not keyboard reachable');
      await page.keyboard.press('Tab');
      if (!(await (await button('cancel')).evaluate((el) => document.activeElement === el)))
        throw Error('Cancel not keyboard reachable');
      await page.keyboard.press('Tab');
      await ui.capture('keyboard-save');
      await page.keyboard.press('Enter');
    } else await (await button('save')).click();
    if (ui.case === 'busy') {
      await (await button('saving')).waitFor();
      await page.keyboard.press('Escape');
      await page.mouse.click(4, 4);
      if (!(await page.getByRole('dialog').count())) throw Error('Busy dialog dismissed');
      await ui.capture('busy');
      return;
    }
    if (ui.case === 'scope') {
      await (await button('saving')).waitFor();
      await page.evaluate(() => {
        window.__switchMetadataScope();
      });
      await (await button('save')).waitFor();
      await page.evaluate(() => window.__completeMetadataSave());
      await name.fill('New scope draft');
      await ui.capture('new-scope');
      if (!(await page.getByRole('dialog').count())) throw Error('Old success closed new dialog');
      await (await button('cancel')).click();
      return;
    }
    if (ui.case === 'error') {
      await page.getByRole('alert').waitFor();
      if ((await name.inputValue()) !== '  Updated project  ') throw Error('Failure lost draft');
      await ui.capture('rejected-kept-draft');
      await (await button('save')).click();
    }
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    const trigger = page.getByRole('button', { name: await t('title'), exact: true });
    await trigger.waitFor();
    await page.waitForFunction(() => document.activeElement?.tagName === 'BUTTON');
    const calls = await page.evaluate(() => window.__metadataCalls);
    const expected =
      ui.case === 'clear'
        ? { projectId: 'fixture-project-a', goal: null }
        : { projectId: 'fixture-project-a', name: 'Updated project' };
    if (
      calls.length !== (ui.case === 'error' ? 2 : 1) ||
      calls.some((call) => JSON.stringify(call) !== JSON.stringify(expected))
    )
      throw Error('Non-minimal or mismatched metadata patch');
  },
};
