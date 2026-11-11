import { describe, expect, it } from 'vitest';

import {
  CONTENT_INSPECTION_REASON,
  isContentInspectionErrorMessage,
  isContentInspectionErrorText,
} from './content-inspection-error.js';

/**
 * Pattern 与 desktop providerErrors.ts 的 CONTENT_INSPECTION_RE、renderer 镜像判定
 * 同语义（三处同步，见模块注释）。正例只用**真实踩过的错误体**，反例守住与
 * context-overflow / overload / network 判定的互斥边界。
 */
describe('isContentInspectionErrorMessage', () => {
  it('matches the 百炼/DashScope 400 body observed on 2026-11-11 (Pi + CN gateway)', () => {
    // 实踩原文（request id 已换成占位，其余形状保持）：内层被包在 `data: ` 里，
    // 是流式响应的 SSE 错误帧，不是 HTTP 头部拒绝。
    const raw =
      '400: {"message":"data: {\\"error\\":{\\"code\\":\\"data_inspection_failed\\",\\"param\\":null,'
      + '\\"message\\":\\"Input text data may contain inappropriate content.\\",'
      + '\\"type\\":\\"data_inspection_failed\\"},\\"id\\":\\"chatcmpl-00000000-0000-0000-0000-000000000000\\"}\\n\\n",'
      + '"type":"invalid_request_error"}';
    expect(isContentInspectionErrorText(raw)).toBe(true);
    expect(isContentInspectionErrorMessage(raw)).toBe(true);
    // 只透出内层 message 正文、外层 envelope 被裁掉时仍须命中。
    expect(
      isContentInspectionErrorMessage('Input text data may contain inappropriate content.'),
    ).toBe(true);
    // 只剩稳定码（各家网关把 code/type 单独透出的形态）。
    expect(isContentInspectionErrorMessage('{"code":"data_inspection_failed"}')).toBe(true);
  });

  it('matches the 500-shaped refusal from #2792 (same deterministic rejection, different status)', () => {
    expect(
      isContentInspectionErrorMessage(
        'API Error: 500 sensitive_words_detected (request id: 202608150810385885953228268d9d6).',
      ),
    ).toBe(true);
  });

  it('takes the stable reason over text so a redacted body still classifies', () => {
    expect(isContentInspectionErrorMessage('', CONTENT_INSPECTION_REASON)).toBe(true);
    expect(isContentInspectionErrorMessage(undefined, CONTENT_INSPECTION_REASON)).toBe(true);
  });

  it('does NOT swallow context-overflow, overload, network or wire errors', () => {
    // 上下文超限：同样是 400 + invalid_request_error 外壳，必须留在自己那类。
    expect(
      isContentInspectionErrorMessage(
        'API Error: 400 {"error":{"type":"invalid_request_error","code":"context_length_exceeded",'
        + '"message":"prompt is too long: 250000 tokens > 200000 maximum"}}',
      ),
    ).toBe(false);
    // 过载 / 网络：都可能自愈，文案与恢复动作完全不同。
    expect(isContentInspectionErrorMessage('Selected model is at capacity. Try again later.')).toBe(false);
    expect(isContentInspectionErrorMessage('529 overloaded_error')).toBe(false);
    expect(isContentInspectionErrorMessage('fetch failed: ECONNREFUSED 127.0.0.1')).toBe(false);
    // wire 兼容性：400 但原因是请求字段，不是内容。
    expect(isContentInspectionErrorMessage('{"error":{"type":"invalid_request_error","message":"Extra inputs are not permitted"}}')).toBe(false);
  });

  it('does NOT treat incidental prose about inappropriate content as a refusal', () => {
    // 只认整句官方措辞与稳定错误码。工具输出、被审查的网页正文、用户粘贴的文本里
    // 出现这几个词，都不构成上游审核拒绝——误判会隐藏本该有用的重试入口。
    expect(isContentInspectionErrorText('The article argues this content is not inappropriate content.')).toBe(false);
    expect(isContentInspectionErrorText('grep -rn "inappropriate" apps/')).toBe(false);
    expect(isContentInspectionErrorText('敏感词过滤已由站点自身的 moderation 中间件处理')).toBe(false);
    expect(isContentInspectionErrorText('')).toBe(false);
    expect(isContentInspectionErrorText(undefined)).toBe(false);
  });
});
