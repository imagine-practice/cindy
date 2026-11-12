// @vitest-environment jsdom
// Unit: real label hook, since the detail-page suite mocks it. Regression:
// blank account names rendered a role and missing profiles leaked internal IDs.
// Minimal inputs: whitespace name, unavailable subject, same-ID account/bot.
import { renderHook, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useProjectSubjectLabel } from '../projectLabels';
import type { ProjectSubject } from '../../../../shared/projects';

const state = vi.hoisted(() => ({ name: '  Lin  ', bots: [{ id: 'shared', name: '  Teammate  ' }] }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ user: { name: state.name }, dataOwnerId: 'shared' }) }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => state.bots }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); state.name = '  Lin  '; });
const subject = (kind: 'account' | 'bot', id: string, displayName: string | null = null): ProjectSubject =>
  ({ kind, id, displayName, avatar: null, avatarColor: null });

it('uses the signed-in nickname without confusing a same-ID teammate', () => {
  const { result } = renderHook(useProjectSubjectLabel);
  expect(result.current(subject('account', 'shared'))).toBe('Lin');
  expect(result.current(subject('bot', 'shared', ' '))).toBe('Teammate');
});

it('uses an account label rather than a role when the current nickname is blank', () => {
  state.name = '  ';
  const { result } = renderHook(useProjectSubjectLabel);
  expect(result.current(subject('account', 'shared'))).toBe('ccAgent.projectCore.form.currentAccount');
});

it('never exposes unresolved account or teammate IDs as names', () => {
  const { result } = renderHook(useProjectSubjectLabel);
  for (const kind of ['account', 'bot'] as const) {
    expect(result.current(subject(kind, 'private-internal-id', ' '))).toBe('ccAgent.projectCore.detail.subjectUnavailable');
  }
});
