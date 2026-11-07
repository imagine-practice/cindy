/**
 * 项目侧的关联群列表（「已关联群」与「同步到群」共用）。
 *
 * 数据来自 `local-db:project-group-links:list-project`：一次只读查询按 `projectId` 读
 * `project_group_links` 里**当前账号 + 本机设备**的 active 行，项目成员资格由 main 校验。
 * 这里不再拿本机群列表逐个群反查项目，也就没有「按群扫一遍 + 60 秒缓存」那套东西：
 * 关联刚被加上/解除时，重新打开页面看到的就是当前关系。
 *
 * 群名只从既有群列表解析（`roomId` 就是群 id）；解析不到时显示 id 本身，不猜名字。
 * 关系行不是发送授权：真正发消息时群通道会自己再鉴权。
 */
import { useEffect, useMemo, useState } from 'react';

import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { refreshBotGroups, useBotGroupList } from '@/features/bots/botGroupStore';
import {
  ProjectGroupLinkError,
  projectGroupLinkAvailable,
  projectGroupLinkErrorKey,
  readProjectGroupLinksByProject,
} from './projectGroupLinkClient';

/** 只含界面可用的最小群信息：不含成员、消息或项目访问凭证。 */
export interface ProjectLinkedGroup { id: string; name: string }

export type ProjectLinkedGroupsState =
  | { status: 'loading' }
  /** 旧宿主没有这条通道：调用方整块不显示，也不假装「没有关联」。 */
  | { status: 'unavailable' }
  | { status: 'ready'; groups: ProjectLinkedGroup[]; truncated: boolean }
  | { status: 'failed'; reasonKey: string };

type Rows = { status: 'loading' } | { status: 'unavailable' }
  | { status: 'ready'; roomIds: string[]; truncated: boolean }
  | { status: 'failed'; reasonKey: string };

export function useProjectLinkedGroups(projectId: string, refreshToken = 0): ProjectLinkedGroupsState {
  const accountId = getDataOwnerGeneration().dataOwnerId;
  const available = projectGroupLinkAvailable();
  const { groups: knownGroups, loaded: groupsLoaded } = useBotGroupList();
  const [rows, setRows] = useState<Rows>({ status: available ? 'loading' : 'unavailable' });

  // 群名来自应用级群列表；直接打开本页时它可能还没拉过。只影响名字，不影响关系读取。
  useEffect(() => { if (available && !groupsLoaded) refreshBotGroups(); }, [available, groupsLoaded]);

  useEffect(() => {
    if (!available || !accountId) { setRows({ status: 'unavailable' }); return; }
    const scope = getDataOwnerGeneration();
    let cancelled = false;
    setRows({ status: 'loading' });
    void readProjectGroupLinksByProject(projectId).then(
      (result) => {
        if (cancelled || !isDataOwnerGenerationCurrent(scope)) return;
        setRows({
          status: 'ready',
          roomIds: result.links.map(link => link.group.roomId),
          truncated: result.truncated,
        });
      },
      (error: unknown) => {
        if (cancelled || !isDataOwnerGenerationCurrent(scope)) return;
        // 统一说「读不到」，并保留 main 给出的可照做原因（非成员 / 宿主未就绪 / 旧版本）。
        setRows({
          status: 'failed',
          reasonKey: error instanceof ProjectGroupLinkError
            ? projectGroupLinkErrorKey(error.code)
            : 'projectGroupLinks.errors.failed',
        });
      },
    );
    return () => { cancelled = true; };
  }, [accountId, available, projectId, refreshToken]);

  // 群名来自应用级群列表；列表晚到时用 id 顶着，不编一个名字。
  return useMemo<ProjectLinkedGroupsState>(() => {
    if (rows.status !== 'ready') return rows;
    const names = new Map(knownGroups.map(group => [group.id, group.name]));
    const groups = rows.roomIds
      .map((roomId): ProjectLinkedGroup => ({ id: roomId, name: names.get(roomId) ?? roomId }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
    return { status: 'ready', groups, truncated: rows.truncated };
  }, [knownGroups, rows]);
}
