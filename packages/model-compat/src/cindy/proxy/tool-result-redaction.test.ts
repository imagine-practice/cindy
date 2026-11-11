import { describe, expect, it } from 'vitest';

import {
  TOOL_RESULT_TEXT_MAX_CHARS,
  redactToolResultPayloads,
  redactToolResultPayloadsInBody,
  redactToolResultText,
} from './tool-result-redaction.js';

const CTX = { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} };

/** 2026-11-11 实踩的 tool_result 形状（字节值换成等长占位，其余保持原样）。 */
const INCIDENT_TOOL_RESULT_TEXT = [
  '=== 正式版 pi key 文件头 ===',
  '00000000: 646a 4577 6346 5a51 3539 7a4b 6d31 6e52  djEwcFZQ59zKm1nR',
  '00000010: 3371 5874 4862 4c67 3956 6357 4679 5a32  3qXtHbLg9VcWFyZ2',
  '00000020: 4e75 5a33 5270 646d 56 7a5a 5851 3d0a 0a    NuZ3RpdmVzZXQ=..',
].join('\n');

function anthropicBody(toolText: string): Record<string, unknown> {
  return {
    model: 'qwen/qwen3.8-27b',
    messages: [
      { role: 'user', content: '检查一下这个文件头' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'xxd key' } }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_1',
            content: [{ type: 'text', text: toolText }],
          },
        ],
      },
    ],
  };
}

describe('redactToolResultText', () => {
  it('replaces the 2026-11-11 hex dump with a digest notice while keeping the surrounding context', () => {
    const out = redactToolResultText(INCIDENT_TOOL_RESULT_TEXT);
    expect(out).not.toBeNull();
    const text = out!;
    // 原始字节不再出现在出站内容里。
    expect(text).not.toContain('646a 4577');
    expect(text).not.toMatch(/^\s*0000[0-9a-f]{4}:/m);
    // 标题这类诊断上下文必须保留：它说明「这是哪个文件的头」。
    expect(text).toContain('=== 正式版 pi key 文件头 ===');
    // 摘要要足够让模型继续排查：行数、字节数、内容哈希、以及正确做法。
    // 转储是 3 行（第一行标题属于上下文，被单独保留），所以这里是 3 而非全部 4 行。
    expect(text).toMatch(/3 line\(s\), \d+ bytes, sha256 [0-9a-f]{16}/);
    expect(text).toContain('sha256sum');
    expect(text).toContain('Do not reconstruct or guess the bytes');
  });

  it('is deterministic, so a poisoned history keeps a stable cache prefix across turns', () => {
    const first = redactToolResultText(INCIDENT_TOOL_RESULT_TEXT);
    const second = redactToolResultText(INCIDENT_TOOL_RESULT_TEXT);
    expect(first).toBe(second);
    // 已净化过的文本再走一遍应判定为「无需改动」，代理因此可以继续字节透传。
    expect(redactToolResultText(first!)).toBeNull();
  });

  it('does not touch ordinary code, logs, or command output', () => {
    const cases = [
      // 源码里的十六进制表：逗号分隔、带 0x 前缀，不是转储。
      'const T = [\n  0x00, 0x01, 0x02, 0x03,\n  0x10, 0x11, 0x12, 0x13,\n];',
      // 正常的 git / sha 输出。
      'commit 646a4577 63465a51 35397a4b\nAuthor: Anber',
      // 普通测试输出。
      '✓ src/app.test.ts (12 tests)\nTest Files 1 passed',
      // 一行里出现偏移样式但不构成转储（少于 3 组字节）。
      'at 0000: ab cd',
      // 有一处 `dead: beef` 这类键值，不应被当成转储。
      'status: dead\nowner: beef',
    ];
    for (const text of cases) {
      expect(redactToolResultText(text), text).toBeNull();
    }
  });

  it('removes PEM private key blocks entirely', () => {
    const text = [
      '=== id_rsa ===',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redactToolResultText(text)!;
    expect(out).not.toContain('OPENSSH PRIVATE KEY-----');
    expect(out).not.toContain('b3BlbnNzaC1rZXkt');
    expect(out).toContain('=== id_rsa ===');
    expect(out).toContain('private key block omitted by Cindy');
  });

  it('redacts high-confidence credential literals only', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactToolResultText(`curl -v\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n${jwt}`)!;
    expect(out).toContain('[REDACTED_BY_CINDY]');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz012345');

    // 源码里的普通标识符不能被抹掉：模型可能把被抹过的片段写回文件。
    expect(redactToolResultText('const token: string = options.token;')).toBeNull();
    expect(redactToolResultText('if (key === undefined) return null;')).toBeNull();
  });

  it('truncates oversized output with an explicit marker', () => {
    const big = `${'h'.repeat(80_000)}${'m'.repeat(20_000)}${'t'.repeat(40_000)}`;
    const out = redactToolResultText(big)!;
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/… \d+ characters omitted by Cindy outbound size limit; total \d+ characters/);
    // 头尾都保留：尾部常见最终结论与错误。
    expect(out.startsWith('h')).toBe(true);
    expect(out.endsWith('t')).toBe(true);
    // 边界：恰好等于上限不动。
    expect(redactToolResultText('x'.repeat(TOOL_RESULT_TEXT_MAX_CHARS))).toBeNull();
  });
});

describe('redactToolResultPayloadsInBody', () => {
  it('redacts an Anthropic tool_result and leaves user/assistant prose untouched', () => {
    const body = anthropicBody(INCIDENT_TOOL_RESULT_TEXT);
    const out = redactToolResultPayloadsInBody(body);
    expect(out).not.toBeNull();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('646a 4577');
    // 用户自己的话与模型的 tool_use 原样保留。
    expect(serialized).toContain('检查一下这个文件头');
    expect(serialized).toContain('"command":"xxd key"');
  });

  it('handles a string-valued Anthropic tool_result content', () => {
    const body = {
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: INCIDENT_TOOL_RESULT_TEXT }] }],
    };
    const out = redactToolResultPayloadsInBody(body);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain('646a 4577');
  });

  it('covers chat-completions tool messages and Responses tool outputs', () => {
    const chat = {
      messages: [
        { role: 'user', content: 'run xxd' },
        { role: 'tool', tool_call_id: 'c1', content: INCIDENT_TOOL_RESULT_TEXT },
      ],
    };
    const chatOut = redactToolResultPayloadsInBody(chat);
    expect(chatOut).not.toBeNull();
    expect(JSON.stringify(chatOut)).not.toContain('646a 4577');

    const responses = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run xxd' }] },
        { type: 'function_call_output', call_id: 'c1', output: INCIDENT_TOOL_RESULT_TEXT },
      ],
    };
    const responsesOut = redactToolResultPayloadsInBody(responses);
    expect(responsesOut).not.toBeNull();
    expect(JSON.stringify(responsesOut)).not.toContain('646a 4577');
  });

  it('also handles block-array tool outputs and Responses input_text/output_text blocks', () => {
    // Responses 的 tool 输出块用 input_text / output_text，不是 Anthropic 的 text。
    const responsesBlocks = {
      input: [{
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_text', text: INCIDENT_TOOL_RESULT_TEXT }],
      }],
    };
    const responsesBlocksOut = redactToolResultPayloadsInBody(responsesBlocks);
    expect(responsesBlocksOut).not.toBeNull();
    expect(JSON.stringify(responsesBlocksOut)).not.toContain('646a 4577');

    const customTool = {
      input: [{ type: 'custom_tool_call_output', call_id: 'c2', output: INCIDENT_TOOL_RESULT_TEXT }],
    };
    const customToolOut = redactToolResultPayloadsInBody(customTool);
    expect(customToolOut).not.toBeNull();
    expect(JSON.stringify(customToolOut)).not.toContain('646a 4577');

    const chatBlocks = {
      messages: [{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: INCIDENT_TOOL_RESULT_TEXT }] }],
    };
    const chatBlocksOut = redactToolResultPayloadsInBody(chatBlocks);
    expect(chatBlocksOut).not.toBeNull();
    expect(JSON.stringify(chatBlocksOut)).not.toContain('646a 4577');
  });

  it('returns null for a clean body so the proxy keeps byte passthrough', () => {
    expect(redactToolResultPayloads(anthropicBody('better-sqlite3 ok'), CTX)).toBeNull();
    expect(redactToolResultPayloads({ messages: 'not-an-array' }, CTX)).toBeNull();
    expect(redactToolResultPayloads(null, CTX)).toBeNull();
    expect(redactToolResultPayloads('text', CTX)).toBeNull();
  });

  it('does not mutate the input body', () => {
    const body = anthropicBody(INCIDENT_TOOL_RESULT_TEXT);
    const before = JSON.stringify(body);
    redactToolResultPayloadsInBody(body);
    expect(JSON.stringify(body)).toBe(before);
  });

  it('cleans a history entry that was persisted before the fix, so a poisoned session heals on send', () => {
    // 事故现场：毒化发生在很久以前的某一轮，它在转录里一直留着。代理每轮看到完整历史，
    // 因此下一次发送时这条历史同样会被净化 —— 用户不需要手工回退。
    const body = anthropicBody(INCIDENT_TOOL_RESULT_TEXT);
    body.messages = [
      ...(body.messages as unknown[]),
      { role: 'user', content: '继续' },
    ];
    const out = redactToolResultPayloadsInBody(body);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain('646a 4577');
  });
});
