export default {
  name: 'material-snapshot-label',
  entry: './fixture.tsx',
  viewport: { width: 320, height: 850 },
  real: 'MaterialSnapshotSection, immutable R1 service, MaterialPreviewDialog and existing themed primitives.',
  notCovered:
    'Synthetic current/history/context/preview bridge; no live page mount, real R2 Host/SQLite/restart/files/permissions/model.',
  cases: {
    default: { about: 'Current empty, removed v2 metadata, v1 snapshot filename/title' },
    unreadable: { about: 'Removed reference and unreadable pinned v1' },
    'metadata-error': { about: 'History failure retains generic unknown title' },
    revoked: { about: 'Authorization refusal clears visible context' },
    rebind: { about: 'Historical context uses original binding, never current epoch' },
  },
  async ready(page) {
    await page.locator('section, [role=alert]').first().waitFor();
  },
  async check(page, ui) {
    const t = (k) => ui.t('ccAgent.materials.' + k);
    if (ui.case === 'rebind') {
      await page.getByRole('button', { name: await t('referenceHistory'), exact: true }).click();
    }
    if (ui.case === 'revoked') {
      await page.getByRole('alert').waitFor();
      if (await page.getByRole('button', { name: await t('preview'), exact: true }).count())
        throw Error('Denied context remained visible');
      return;
    }
    const filename =
      ui.locale === 'zh-CN'
        ? '项目需求与参考资料——重启后保留历史版本名称.txt'
        : 'project-requirements-and-material-reference-original-snapshot-v1.txt';
    const label = ui.case === 'metadata-error' ? await t('snapshot.refUnknown') : filename;
    await page.getByText(label, { exact: true }).waitFor();
    if (
      await page.getByRole('button', { name: await t('snapshot.create'), exact: true }).isEnabled()
    )
      throw Error('Historical row became a write candidate');
    await ui.capture('snapshot-original-label');
    const preview = page.getByRole('button', { name: await t('preview'), exact: true });
    await preview.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: label, exact: true }).waitFor();
    if (ui.case === 'unreadable')
      await page.getByText(await t('sourceMissing'), { exact: true }).waitFor();
    else await page.getByText('Fixture immutable snapshot v1', { exact: true }).waitFor();
    const calls = await page.evaluate(() => window.__snapshotLabelPreviews);
    if (
      JSON.stringify(calls) !==
      JSON.stringify([
        { contextId: 'fixture-context-v1', materialId: 'fixture-material', version: 1 },
      ])
    )
      throw Error('Snapshot preview drifted from v1');
    if (await page.evaluate(() => window.__snapshotLabelWrites))
      throw Error('Snapshot metadata wrote a relationship');
    await ui.capture('snapshot-preview-v1');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  },
};
