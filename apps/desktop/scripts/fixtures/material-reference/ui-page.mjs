export default {
  name: 'material-reference',
  entry: './material-reference-fixture.tsx',
  viewport: { width: 320, height: 820 },
  real: 'Real WorkItemMaterialsPage/Panel/Row/Preview/Snapshot and strict R1 service; real Radix dialogs/selects.',
  notCovered:
    'Synthetic preload receipts. No R2 host/DB/uploads/real permission or model binding. Native clipboard images without a path remain unsupported.',
  cases: {
    default: { about: 'Selected v1 and latest v2, snapshot remains v1, preview keyboard focus' },
    empty: { about: 'Empty materials and snapshots' },
  },
  async ready(page) {
    await page.getByRole('heading', { name: 'Reference material versions' }).waitFor();
  },
  async check(page, ui) {
    const t = (k, values) => ui.t('ccAgent.materials.' + k, values);
    if (ui.case === 'empty') {
      await page.getByText(await t('emptyTitle')).waitFor();
      return;
    }
    const first = page
      .getByRole('listitem')
      .filter({ hasText: 'project-requirements-and-material-reference-version-history.pdf' })
      .first();
    const row =
      ui.locale === 'de'
        ? page
            .getByRole('listitem')
            .filter({
              hasText:
                'Projektanforderungen-und-Referenzmaterialien-mit-einem-sehr-langen-Dateinamen.pdf',
            })
            .first()
        : first;
    await row.getByRole('button', { name: await t('versionHistory', { count: 2 }) }).click();
    await row.getByText(await t('latestVersion', { version: 2 })).waitFor();
    const nameBox=await row.locator('span[title]').first().boundingBox();
    if(!nameBox || nameBox.width<100)throw new Error('File name squeezed by row actions');
    await ui.capture('selected-v1-latest-v2');
    const trigger = row.getByRole('button', { name: await t('preview'), exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Fixture material version 1', { exact: false }).waitFor();
    await ui.capture('preview-v1');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(el=>el===document.activeElement,await trigger.elementHandle());
    await page.getByRole('button', { name: await t('snapshot.create') }).click();
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('alertdialog').getByRole('combobox').first().click();
    await page.getByRole('listbox').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('listbox').waitFor({ state: 'detached' });
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  },
};
