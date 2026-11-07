import assert from 'node:assert/strict';
import base from '../project-core/ui-page.mjs';
export default {
 name: 'project-progress-page', entry: './page-fixture.tsx', viewport: { width: 390, height: 900 }, stubs: base.stubs,
 real: 'Actual ProjectDetailPage + progress container/service + frozen read-only view, router and theme/i18n providers',
 notCovered: 'Controlled preload snapshot only; no Host/DB, real account authorization, Electron isolation or progress editor',
 cases: { default: { about: '320px actual page and keyboard navigation', viewport: { width: 320, height: 900 } },
  'narrow-390': { about: '390px actual page and keyboard navigation' }, empty: { about: 'Empty actual progress response' },
  error: { about: 'Progress error and safe retry' }, forbidden: { about: 'Revoked read removes entire sensitive detail' },
  loading: { about: 'Pending progress read' } },
 async ready(page) {
  const scenario = await page.evaluate(() => window.__uiPage.ctx.case);
  const t = key => page.evaluate(k => window.__uiPage.t(`ccAgent.projectCore.progress.${k}`), key);
  if (scenario === 'forbidden') { await page.getByRole('heading', { name: await t('forbidden') }).waitFor(); return; }
  await page.getByRole('heading', { name: '春季项目', exact: true }).waitFor();
  if (scenario === 'loading' || scenario === 'error') await page.getByText(await t(scenario), { exact: true }).waitFor();
  else if (scenario === 'empty') await page.getByText(await t('empty'), { exact: true }).waitFor();
  else await page.getByRole('button', { name: '整理交付记录', exact: true }).waitFor();
 },
 async check(page, ui) {
  const t = key => ui.t(`ccAgent.projectCore.progress.${key}`);
  if (ui.case === 'forbidden') { assert.equal(await page.getByText('春季项目', { exact: true }).count(), 0); return; }
  if (ui.case === 'error') { const retry = page.getByRole('button', { name: await t('retry'), exact: true });
    await retry.focus(); await page.keyboard.press('Enter'); await page.getByRole('alert').waitFor(); return; }
  if (!['default','narrow-390'].includes(ui.case)) return;
  const region = page.getByRole('region', { name: await t('title'), exact: true });
  const all = region.getByRole('button', { name: new RegExp(`${await t('all')}.*3`) });
  await all.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await all.evaluate(el => document.activeElement === el), true);
  await ui.capture('keyboard-focus');
  const more = page.getByRole('button', { name: await t('loadEarlier'), exact: true });
  await more.focus(); await page.keyboard.press('Enter'); await more.waitFor({ state: 'detached' });
  const task = region.getByRole('button', { name: '整理交付记录', exact: true });
  await task.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.getByLabel('fixture-target').textContent(), 'task-2');
  await page.getByRole('button', { name: '返回模拟项目' }).click();
  await page.getByRole('heading', { name: '春季项目', exact: true }).waitFor();
 }
};
