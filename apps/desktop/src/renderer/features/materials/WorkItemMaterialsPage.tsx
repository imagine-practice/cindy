import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FolderKanban } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/httpClient';
import { onProjectsChanged } from '../projects/projectService';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import type { MaterialScope, MaterialsListResult } from '../../../shared/materials';
import { createMaterialReferenceService } from './materialReferenceService';
import { readMaterialTaskScope } from './materialScopeRead';
import {
  isScopeInvalidation,
  materialErrorCode,
  materialErrorKey,
  type MaterialReferenceService,
  type TaskMaterialScope,
} from './materialReferenceView';
import { MaterialsPanel } from './MaterialsPanel';
import { MaterialSnapshotSection } from './MaterialSnapshotSection';
interface Ready {
  service: MaterialReferenceService;
  scope: TaskMaterialScope;
  title: string;
  current: MaterialsListResult;
}
export function WorkItemMaterialsPage(): React.ReactElement {
  const { projectId = '', sessionId = '' } = useParams();
  const auth = useOptionalAuth();
  return (
    <WorkItemMaterialsScope
      key={JSON.stringify([
        projectId,
        sessionId,
        auth?.dataOwnerId,
        auth?.dataOwnerGeneration,
        getDataOwnerGeneration(),
      ])}
      projectId={projectId}
      sessionId={sessionId}
    />
  );
}
function WorkItemMaterialsScope({
  projectId,
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [ready, setReady] = useState<Ready | null>(null);
  const readyRef = useRef<Ready | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(false);
  const subscribed = useRef(false);
  const sequence = useRef(0);
  const owner = useRef(getDataOwnerGeneration());
  const service = useRef<MaterialReferenceService | null>(null);
  const active = useCallback(
    () => mounted.current && isDataOwnerGenerationCurrent(owner.current),
    [],
  );
  const invalidate = useCallback(
    (failure: unknown) => {
      if (!active()) return;
      sequence.current++;
      service.current?.dispose();
      service.current = null;
      readyRef.current = null;
      setReady(null);
      setError(failure);
      setLoading(false);
    },
    [active],
  );
  const load = useCallback(async (): Promise<void> => {
    if (!active()) return;
    const ticket = ++sequence.current;
    const valid = () => active() && sequence.current === ticket;
    setLoading(true);
    try {
      if (!subscribed.current)
        throw new ApiError('PRECONDITION_FAILED', 0, 'Project change subscription is unavailable');
      const observed = await readMaterialTaskScope(projectId, sessionId);
      if (!valid()) return;
      if (
        !service.current ||
        JSON.stringify(service.current.scope) !== JSON.stringify(observed.scope)
      ) {
        service.current?.dispose();
        readyRef.current = null;
        setReady(null);
        service.current = createMaterialReferenceService(observed.scope);
      }
      const current = await service.current.list();
      if (!valid()) return;
      const next = {
        service: service.current,
        scope: observed.scope,
        title: observed.title,
        current,
      };
      readyRef.current = next;
      setReady(next);
      setError(null);
    } catch (failure: unknown) {
      if (!valid()) return;
      if (isScopeInvalidation(failure) || !readyRef.current) {
        service.current?.dispose();
        service.current = null;
        readyRef.current = null;
        setReady(null);
      }
      setError(failure);
      throw failure;
    } finally {
      if (valid()) setLoading(false);
    }
  }, [active, projectId, sessionId]);
  useEffect(() => {
    mounted.current = true;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = onProjectsChanged(() => {
        if (active()) {
          service.current?.dispose();
          service.current = null;
          readyRef.current = null;
          setReady(null);
          void load().catch(() => {});
        }
      });
      if (typeof unsubscribe !== 'function') throw new Error('Missing project change subscription');
      subscribed.current = true;
      void load().catch(() => {});
    } catch {
      invalidate(
        new ApiError('PRECONDITION_FAILED', 0, 'Project change subscription is unavailable'),
      );
    }
    return () => {
      mounted.current = false;
      subscribed.current = false;
      sequence.current++;
      service.current?.dispose();
      unsubscribe?.();
    };
  }, [load, active, invalidate]);
  const back = () => navigate(`/cc-agent/projects/${projectId}`);
  if (!ready)
    return (
      <PageShell
        title={t(
          error ? materialErrorKey(materialErrorCode(error)) : 'ccAgent.materials.workItem.loading',
        )}
        onBack={back}
        backLabel={t('ccAgent.materials.workItem.back')}
      >
        {!!error && (
          <Button variant="secondary" size="sm" onClick={() => void load().catch(() => {})}>
            {t('ccAgent.materials.retryLoad')}
          </Button>
        )}
      </PageShell>
    );
  return (
    <div className="app-wallpaper-surface flex h-full w-full flex-col bg-[hsl(var(--content-area))]">
      <header
        className="flex min-h-[68px] shrink-0 items-center gap-3 border-b border-[var(--cmd-palette-border)] px-6 py-4"
        style={WINDOW_DRAG_STYLE}
      >
        <BackButton onClick={back} label={t('ccAgent.materials.workItem.back')} />
        <FolderKanban
          size={18}
          strokeWidth={1.75}
          className="text-[var(--settings-section-desc)]"
        />
        <h1
          title={ready.title}
          className="min-w-0 truncate text-18 font-medium text-[var(--msg-assistant-text)]"
        >
          {ready.title}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-8 pb-8">
          <MaterialsPanel
            key={'panel' + JSON.stringify(ready.scope)}
            scope={ready.scope}
            service={ready.service}
            materials={ready.current.materials}
            loading={loading}
            loadError={error}
            writeBlocked={loading || !!error}
            onReload={load}
            onInvalidate={invalidate}
            onCurrent={(current) => {
              if (!active() || readyRef.current?.service !== ready.service) return;
              const next = { ...readyRef.current, current };
              readyRef.current = next;
              setReady(next);
            }}
          />
          <div className="h-px w-full bg-[var(--cmd-palette-border)]" aria-hidden />
          <MaterialSnapshotSection
            key={'snapshots' + JSON.stringify(ready.scope)}
            scope={ready.scope}
            service={ready.service}
            materials={ready.current.materials}
            writeBlocked={loading || !!error}
            onInvalidate={invalidate}
          />
        </div>
      </div>
    </div>
  );
}
function PageShell({
  title,
  onBack,
  backLabel,
  children,
}: {
  title: string;
  onBack: () => void;
  backLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="app-wallpaper-surface flex h-full w-full flex-col bg-[hsl(var(--content-area))]">
      <header
        className="flex min-h-[68px] shrink-0 items-center gap-3 border-b border-[var(--cmd-palette-border)] px-6 py-4"
        style={WINDOW_DRAG_STYLE}
      >
        <BackButton onClick={onBack} label={backLabel} />
        <h1 className="truncate text-18 font-medium leading-none text-[var(--msg-assistant-text)]">
          {title}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">{children}</div>
      </div>
    </div>
  );
}

function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-desc)]',
        'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
      style={WINDOW_NO_DRAG_STYLE}
    >
      <ArrowLeft size={16} strokeWidth={1.75} />
    </button>
  );
}
