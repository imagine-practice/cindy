import assert from 'node:assert/strict';
export default {
  name: 'project-progress',
  entry: './progress-fixture.tsx',
  viewport: { width: 390, height: 900 },
  real: 'ProjectProgressView, production projection, frozen summary/mapping functions, Button and all locale/theme providers',
  notCovered:
    'ProjectDetailPage mounting, real IPC/DB, membership authorization, binding epoch producer, progress editing and persistence',
  cases: {
    default: {
      about: '320px counts, IDs, keyboard, history and transitions',
      viewport: { width: 320, height: 900 },
    },
    'narrow-390': { about: '390px counts, IDs, keyboard, history and transitions' },
    empty: { about: 'No work items and no history' },
    loading: { about: 'Loading hides all body content' },
    forbidden: { about: 'Forbidden hides all body content' },
    error: { about: 'Safe error and one retry callback' },
    duplicate: { about: 'Conflicting stable IDs produce a safe data error' },
  },
  async ready(page) {
    await page.getByRole('region').waitFor();
  },
  async check(page, ui) {
    const t = (key) => ui.t(`ccAgent.projectCore.progress.${key}`);
    if (ui.case === 'error' || ui.case === 'duplicate') {
      await page.getByRole('button', { name: await t('retry'), exact: true }).click();
      assert.equal(await page.getByLabel('fixture-action').textContent(), 'retry');
      return;
    }
    if (ui.case !== 'default' && ui.case !== 'narrow-390') return;
    const filter = page.getByRole('group', { name: await t('filter') });
    const all = filter.getByRole('button', { name: `${await t('all')} · 6`, exact: true });
    await all.waitFor();
    const blocked = filter.getByRole('button', { name: `${await t('blocked')} · 1`, exact: true });
    await all.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await all.evaluate((el) => document.activeElement === el), true);
    await blocked.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.getByRole('button', { name: 'Same task', exact: true }).count(), 1);
    await ui.capture('blocked');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await all.focus();
    await page.keyboard.press('Enter');
    const tasks = page.getByRole('button', { name: 'Same task', exact: true });
    assert.equal(await tasks.count(), 6);
    await tasks.nth(1).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByLabel('fixture-action').textContent(), 'done');
    await page.getByRole('button', { name: await t('showAll'), exact: true }).click();
    await ui.capture('history');
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('progress-fixture-state', {
          detail: { projectId: 'p', state: { status: 'loading' } },
        }),
      ),
    );
    await page.getByText(await t('loading'), { exact: true }).waitFor();
    assert.equal(await tasks.count(), 0);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('progress-fixture-state', {
          detail: { projectId: 'q', state: { status: 'forbidden' } },
        }),
      ),
    );
    await page.getByText(await t('forbidden'), { exact: true }).waitFor();
    assert.equal(await page.getByText('Project owner', { exact: false }).count(), 0);
  },
};
