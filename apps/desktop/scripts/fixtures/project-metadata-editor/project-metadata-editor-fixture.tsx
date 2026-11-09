/** Isolated UI: real dialog + primitives; synthetic project and controlled save callback. No service/Host. */
import { useState } from 'react';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../src/renderer/components/ui/button';
import {
  EditProjectDialog,
  type ProjectMetadataPatch,
} from '../../../src/renderer/features/projects/EditProjectDialog';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
declare global {
  interface Window {
    __metadataCalls: ProjectMetadataPatch[];
    __completeMetadataSave?: () => void;
    __switchMetadataScope?: () => void;
  }
}
function Fixture({ ctx }: { ctx: UiPageContext }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [epoch, setEpoch] = useState(1);
  const [failed, setFailed] = useState(false);
  window.__switchMetadataScope = () => {
    setDataOwnerGeneration('fixture-owner', 2);
    setEpoch(2);
  };
  const longName =
    ctx.locale === 'de'
      ? 'Langfristige Planung und Abstimmung der Projektziele mit einer gut lesbaren Projektbezeichnung'
      : '项目需求与目标规划——在不同屏幕中明确名称与目标，保留已填写内容';
  const goal =
    ctx.locale === 'de'
      ? `Die Projektziele gemeinsam prüfen und präzisieren. Lange Texte bleiben innerhalb des Dialogs lesbar.
`.repeat(5)
      : `记录项目期望达成的目标，供成员核对与完善。较长的内容应在弹窗内部滚动，不遮挡保存和取消。
`.repeat(5);
  return (
    <div className="app-wallpaper-surface min-h-full bg-[hsl(var(--content-area))] p-4">
      <Button onClick={() => setOpen(true)}>{t('ccAgent.projectCore.metadataEdit.title')}</Button>
      <EditProjectDialog
        open={open}
        projectId={epoch === 1 ? 'fixture-project-a' : 'fixture-project-b'}
        name={longName}
        goal={goal}
        scopeToken={`view-${epoch}`}
        canEdit={ctx.case !== 'readonly'}
        onOpenChange={setOpen}
        onSave={async (patch) => {
          window.__metadataCalls.push(patch);
          if (ctx.case === 'busy' || ctx.case === 'scope')
            await new Promise<void>((resolve) => {
              window.__completeMetadataSave = resolve;
            });
          if (ctx.case === 'error' && !failed) {
            setFailed(true);
            throw new Error('denied');
          }
        }}
      />
    </div>
  );
}
mountPage({
  host: () => {
    setDataOwnerGeneration('fixture-owner', 1);
    window.__metadataCalls = [];
    return {};
  },
  render: (ctx) => <Fixture ctx={ctx} />,
});
