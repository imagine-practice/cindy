import assert from 'node:assert/strict';
import base from '../project-core/ui-page.mjs';
const auth = 'src/renderer/contexts/AuthContext';
export default {
 name: 'project-progress-edit-page', entry: './page-fixture.tsx', viewport: { width: 390, height: 900 },
 stubs: { ...base.stubs, [auth]: { partial: base.stubs[auth].partial.includes('useOptionalDataOwnerGeneration') ? base.stubs[auth].partial : base.stubs[auth].partial + '\nexport const useOptionalDataOwnerGeneration = () => 1;' } },
 real: 'Actual ProjectDetailPage, container, service, frozen E1 dialog and real Radix Select, theme/i18n providers',
 notCovered: 'Controlled preload responses; no Host identity, SQL or actual Electron isolation. Joint SQL path is tested separately under Node.',
 cases: { default: { about: '320px full-page blocked editor and full scrim click', viewport: { width: 320, height: 900 } },
  done: { about: '390px owner progress confirmation and real reread' }, conflict: { about: 'Revision conflict locks until explicit refresh' },
  uncertain: { about: 'Unknown outcome retries exactly the same request' }, saving: { about: 'Closing busy editor does not claim cancellation' } },
 async ready(page) {
  const scenario = await page.evaluate(() => window.__uiPage.ctx.case);
  const t = key => page.evaluate(k => window.__uiPage.t(`ccAgent.projectCore.progressEdit.${k}`), key);
  const trigger = page.getByRole('button', { name: `${await t('title')} — Review current evidence`, exact: true });
  await trigger.waitFor(); await trigger.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog'); await dialog.waitFor();
  const select = dialog.getByRole('combobox'); assert.equal(await select.evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  assert.equal(await select.evaluate(el => document.activeElement === el), true);
  await select.click(); await page.getByRole('option', { name: await t(`status.${scenario === 'done' ? 'done' : scenario === 'default' ? 'blocked' : 'doing'}`), exact: true }).click();
  if (scenario === 'default') {
   await dialog.getByLabel(await t('reason'), { exact: false }).fill('Waiting for updated evidence.');
   await dialog.getByLabel(await t('condition'), { exact: false }).fill('Evidence is available.');
   await page.mouse.click(4, 4); assert.equal(await dialog.count(), 1);
  }
  if (scenario === 'done') { await dialog.getByLabel(await t('note'), { exact: false }).fill('Owner confirmed work progress.'); await dialog.getByRole('checkbox').check(); }
  if (['conflict','uncertain','saving'].includes(scenario)) {
   await dialog.getByRole('button', { name: await t('save'), exact: true }).click();
   if (scenario === 'saving') await dialog.getByRole('status').waitFor();
   else await dialog.getByRole('alert').waitFor();
  }
 },
 async check(page, ui) {
  const t = key => ui.t(`ccAgent.projectCore.progressEdit.${key}`); const dialog = page.getByRole('dialog');
  if (ui.case === 'conflict') {
   assert.equal(await dialog.getByRole('button', { name: await t('save'), exact: true }).isDisabled(), true);
   await dialog.getByRole('button', { name: await t('refresh'), exact: true }).click();
   await dialog.waitFor({ state: 'detached' });
  } else if (ui.case === 'uncertain') {
   await dialog.getByRole('button', { name: await t('retry'), exact: true }).click(); await dialog.waitFor({ state: 'detached' });
   const calls = await page.evaluate(() => window.__progressWriteCalls); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
  } else if (ui.case === 'saving') {
   await dialog.getByRole('button', { name: await t('close'), exact: true }).click(); await dialog.waitFor({ state: 'detached' });
   assert.equal(await page.evaluate(() => window.__progressWriteCalls.length), 1);
  } else {
   await ui.capture('keyboard-editor');
   await dialog.getByRole('button', { name: await t('save'), exact: true }).click(); await dialog.waitFor({ state: 'detached' });
   const calls = await page.evaluate(() => window.__progressWriteCalls); assert.equal(calls[0].expectedBindingRevision, 7);
   assert.equal(calls[0].expectedRevision, ui.case === 'done' ? 3 : 0);
   const edit = page.getByRole('button', { name: `${await t('title')} — Review current evidence`, exact: true });
   await edit.waitFor(); await edit.focus(); await page.keyboard.press('Enter'); await page.getByRole('dialog').waitFor();
   await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'detached' });
   assert.equal(await edit.evaluate(el => document.activeElement === el), true);
  }
 }
};
