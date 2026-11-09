/**
 * 群授权身份比对口径的回归。
 *
 * 真实现场：国内认证域返回的 externalId 是 `https://auth.cindy.com.cn#cmvt…`，
 * 直接和账号 id 比字符串会把本人判成「不是本人」，于是群↔项目关联永远被拒。
 */
import { describe, expect, it } from 'vitest';

import { externalIdMatchesAccount } from '../chatGroupAuthority';

const ACCOUNT = 'cmvt459dj0777v401shagok08';

describe('externalIdMatchesAccount', () => {
  it('accepts the plain account id', () => {
    expect(externalIdMatchesAccount(ACCOUNT, ACCOUNT)).toBe(true);
  });

  it('accepts the realm-qualified CN form', () => {
    expect(externalIdMatchesAccount(`https://auth.cindy.com.cn#${ACCOUNT}`, ACCOUNT)).toBe(true);
  });

  it('accepts a URL whose last path segment is the account id', () => {
    expect(externalIdMatchesAccount(`https://auth.cindy.com.cn/users/${ACCOUNT}`, ACCOUNT)).toBe(true);
  });

  it('rejects another account, another realm identity and empty values', () => {
    expect(externalIdMatchesAccount('cmvt00000000000000000000', ACCOUNT)).toBe(false);
    expect(externalIdMatchesAccount('https://auth.cindy.com.cn#someone-else', ACCOUNT)).toBe(false);
    expect(externalIdMatchesAccount('', ACCOUNT)).toBe(false);
    expect(externalIdMatchesAccount(ACCOUNT, '')).toBe(false);
  });
});
