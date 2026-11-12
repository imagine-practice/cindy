import { describe, expect, it } from 'vitest';

import {
  TOOL_RESULT_TEXT_MAX_CHARS,
  redactToolResultPayloads,
  redactToolResultPayloadsInBody,
  redactToolResultText,
} from './tool-result-redaction.js';

const CTX = { reqId: 1, method: 'POST', url: '/v1/messages', headers: {} };

/** 2026-11-11 实踩的 tool_result 形状（字节值换成等长占位，结构保持：等宽 4 字符组、16 字节/行）。 */
const INCIDENT_TOOL_RESULT_TEXT = [
  '=== 正式版 pi key 文件头 ===',
  '00000000: 646a 4577 6346 5a51 3539 7a4b 6d31 6e52  djEwcFZQ59zKm1nR',
  '00000010: 3371 5874 4862 4c67 3956 6357 4679 5a32  3qXtHbLg9VcWFyZ2',
  '00000020: 4e75 5a33 5270 646d 567a 5a58 513d 0a0a  NuZ3RpdmVzZXQ=..',
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

describe('redactToolResultText — 转储识别', () => {
  it('replaces the 2026-11-11 hex dump with a digest notice while keeping the surrounding context', () => {
    const text = redactToolResultText(INCIDENT_TOOL_RESULT_TEXT)!;
    expect(text).not.toContain('646a 4577');
    expect(text).not.toMatch(/^\s*0000[0-9a-f]{4}:/m);
    // 标题这类诊断上下文必须保留：它说明「这是哪个文件的头」。
    expect(text).toContain('=== 正式版 pi key 文件头 ===');
    // 3 行转储（标题行属于上下文，被单独保留）。
    expect(text).toMatch(/3 line\(s\), \d+ bytes, sha256 [0-9a-f]{16}/);
    expect(text).toContain('sha256sum');
    expect(text).toContain('Do not reconstruct or guess the bytes');
    // Pi 的 `bash` 与 `powershell` 是两个并列工具，同一台机器上都能用；notice 只给
    // POSIX 形态会让 PowerShell 会话拿到跑不通的指引。两边命令都必须出现。
    expect(text).toContain('sha256sum');
    expect(text).toContain('Get-FileHash');
  });

  it('detects CRLF dumps, which previously slipped through entirely', () => {
    // Windows 上 PowerShell 系命令的输出是 CRLF。旧实现用 $ 锚在 split(\n) 得到的行上，
    // \r 卡在 $ 之前，于是整段转储漏检。
    const crlf = [
      '00000000: 646a 4577 6346 5a51 3539 7a4b 6d31 6e52  djEwcFZQ59zKm1nR\r',
      '00000010: 3371 5874 4862 4c67 3956 6357 4679 5a32  3qXtHbLg9VcWFyZ2\r',
    ].join('\n');
    const out = redactToolResultText(crlf);
    expect(out).not.toBeNull();
    expect(out).not.toContain('646a 4577');
    expect(out).toContain('sha256');
    // 无 ASCII 列的 CRLF 转储同样要命中。
    const noAscii = [
      '00000000: 646a 4577 6346 5a51 3539 7a4b 6d31 6e52\r',
      '00000010: 3371 5874 4862 4c67 3956 6357 4679 5a32\r',
    ].join('\n');
    expect(redactToolResultText(noAscii)).not.toBeNull();
  });

  it('does not mistake numeric tables (TSV / CSV / column -t) for a dump', () => {
    // review 发现：组宽 3 的数值列曾被当成十六进制字节组，整张表被抹掉。
    const cases = [
      '20240101\t120\t340\t560\t780\t900',
      '20240102\t130\t350\t570\t790\t910',
      '1234 240 350 460 570 680\n1235 241 351 461 571 681',
      '2024-01-01\t120\t340',
      'id,name,value\n1,alpha,340\n2,beta,560',
    ];
    for (const text of cases) expect(redactToolResultText(text), text).toBeNull();
  });

  it('does not mistake disassembly listings for a dump', () => {
    const cases = [
      // llvm-objdump：列间多个空格 + 制表符 + 助记符。旧实现按「组数≥5 或连续两行」判成转储。
      '  401136: 48 83 ec 08        \tsubq\t$8, %rsp\n  40113a: 48 89 7d f8        \tmovq\t%rdi, -8(%rbp)',
      // gdb disassemble。
      '   0x0000000000401136 <+0>:\t48 83 ec 08\tsub    $0x8,%rsp\n   0x000000000040113a <+4>:\t48 89 7d f8\tmov    %rdi,-0x8(%rbp)',
    ];
    for (const text of cases) expect(redactToolResultText(text), text).toBeNull();
  });

  it('does not touch ordinary code, logs, or command output', () => {
    const cases = [
      'const T = [\n  0x00, 0x01, 0x02, 0x03,\n  0x10, 0x11, 0x12, 0x13,\n];',
      'commit 646a4577 63465a51 35397a4b\nAuthor: Anber',
      '✓ src/app.test.ts (12 tests)\nTest Files 1 passed',
      'at 0000: ab cd',
      'status: dead\nowner: beef',
    ];
    for (const text of cases) expect(redactToolResultText(text), text).toBeNull();
  });
});

describe('redactToolResultText — 凭据', () => {
  it('removes paired PEM private key blocks', () => {
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
  });

  it('removes an orphan BEGIN block (head/sed/base64 reads), which previously leaked', () => {
    // 成对规则要求 BEGIN+END；`head -3 ~/.ssh/id_ed25519` 只有 BEGIN，身体是 base64，
    // 既不命中 hexdump 也不命中厂商前缀 —— review 前这条路径完全裸奔。
    const orphan = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      'QyNTUxOQAAACD',
    ].join('\n');
    const out = redactToolResultText(orphan);
    expect(out).not.toBeNull();
    expect(out).not.toContain('b3BlbnNzaC1rZXkt');
    expect(out).toContain('private key block omitted');
  });

  it('removes PGP armored private keys', () => {
    const pgp = [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'lQOYBF8AAAABCADG',
      '-----END PGP PRIVATE KEY BLOCK-----',
      'after',
    ].join('\n');
    const out = redactToolResultText(pgp)!;
    expect(out).not.toContain('lQOYBF8AAAABCADG');
    expect(out).toContain('after');
  });

  it('redacts real vendor key shapes', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const keys = [
      // 占位值特意用低熵（扫描器按熵判定真实密钥）：只需满足本模块的厂商形态正则。
      // 高熵字面量会被 GitHub push protection 判成真实密钥并阻止推送。
      // 长度按各条正则的下界算：sk_live_ ≥16、sk-proj- ≥32、ghp_/github_pat_ ≥20、
      // AKIA 恰好 16 位大写数字、AIza 恰好 35 位。
      'sk_live_EXAMPLEEXAMPLE00',
      'sk-proj-EXAMPLEEXAMPLEEXAMPLEEXAMPLE1234',
      'ghp_EXAMPLEEXAMPLEEXAMPLE',
      'github_pat_EXAMPLEEXAMPLEEXAMPLE',
      'xoxb-EXAMPLEEXAMPLE-000',
      'AKIAEXAMPLEEXAMPLE00',
      'AIzaEXAMPLEEXAMPLEEXAMPLEEXAMPLEEXAMPLE',
    ];
    for (const key of keys) {
      const out = redactToolResultText(`token=${key}`);
      expect(out, key).not.toBeNull();
      expect(out, key).not.toContain(key);
    }
    expect(redactToolResultText(`curl -v\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345`)!).not.toContain(
      'abcdefghijklmnopqrstuvwxyz012345',
    );
    expect(redactToolResultText(jwt)!).not.toContain(jwt);
  });

  it('does not redact ordinary identifiers that merely start with a key-like prefix', () => {
    // review 发现：裸 `(?:sk|pk|rk)[-_A-Za-z0-9]{16,}` 会把这三类真实输出抹成占位符，
    // 模型随后可能把被抹过的片段写回文件。
    const cases = [
      'CREATE INDEX pk_orders_customer_id_index ON orders(customer_id);',
      'ASIA_PACIFIC_REGION_ENDPOINT = "https://example.invalid"',
      "Switched to branch 'sk-1234-add-login-redirect'",
      'const token: string = options.token;',
      'if (key === undefined) return null;',
      'import sklearn\nfrom sklearn.datasets import load_iris',
    ];
    for (const text of cases) expect(redactToolResultText(text), text).toBeNull();
  });
});

describe('redactToolResultText — 截断与稳定性', () => {
  it('truncates oversized output with an explicit marker', () => {
    const big = `${'h'.repeat(80_000)}${'m'.repeat(20_000)}${'t'.repeat(40_000)}`;
    const out = redactToolResultText(big)!;
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/… \d+ characters omitted by Cindy outbound size limit; total \d+ characters/);
    expect(out.startsWith('h')).toBe(true);
    expect(out.endsWith('t')).toBe(true);
    expect(redactToolResultText('x'.repeat(TOOL_RESULT_TEXT_MAX_CHARS))).toBeNull();
  });

  it('does not cut through a surrogate pair when truncating', () => {
    // 头部边界落在一个 emoji 的中间时，不能留下孤立代理。
    const head = `${'a'.repeat(69_999)}😀`;
    const out = redactToolResultText(`${head}${'b'.repeat(60_000)}`)!;
    expect(out.isWellFormed()).toBe(true);
  });

  it('is deterministic and idempotent, so a poisoned history keeps a stable cache prefix', () => {
    const first = redactToolResultText(INCIDENT_TOOL_RESULT_TEXT);
    expect(first).toBe(redactToolResultText(INCIDENT_TOOL_RESULT_TEXT));
    expect(redactToolResultText(first!)).toBeNull();
  });
});

describe('redactToolResultPayloadsInBody', () => {
  it('redacts an Anthropic tool_result and leaves user/assistant prose untouched', () => {
    const out = redactToolResultPayloadsInBody(anthropicBody(INCIDENT_TOOL_RESULT_TEXT));
    expect(out).not.toBeNull();
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('646a 4577');
    expect(serialized).toContain('检查一下这个文件头');
    expect(serialized).toContain('"command":"xxd key"');
  });

  it('handles a string-valued Anthropic tool_result content', () => {
    const out = redactToolResultPayloadsInBody({
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: INCIDENT_TOOL_RESULT_TEXT }] }],
    });
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain('646a 4577');
  });

  it('covers chat-completions tool/function messages and all Responses tool output items', () => {
    const bodies = [
      { messages: [{ role: 'tool', tool_call_id: 'c1', content: INCIDENT_TOOL_RESULT_TEXT }] },
      { messages: [{ role: 'function', name: 'run', content: INCIDENT_TOOL_RESULT_TEXT }] },
      { messages: [{ role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: INCIDENT_TOOL_RESULT_TEXT }] }] },
      { input: [{ type: 'function_call_output', call_id: 'c1', output: INCIDENT_TOOL_RESULT_TEXT }] },
      { input: [{ type: 'custom_tool_call_output', call_id: 'c2', output: INCIDENT_TOOL_RESULT_TEXT }] },
      { input: [{ type: 'local_shell_call_output', call_id: 'c3', output: INCIDENT_TOOL_RESULT_TEXT }] },
      { input: [{ type: 'computer_call_output', call_id: 'c4', output: INCIDENT_TOOL_RESULT_TEXT }] },
      { input: [{ type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_text', text: INCIDENT_TOOL_RESULT_TEXT }] }] },
    ];
    for (const [index, body] of bodies.entries()) {
      const out = redactToolResultPayloadsInBody(body);
      expect(out, `shape ${index}`).not.toBeNull();
      expect(JSON.stringify(out), `shape ${index}`).not.toContain('646a 4577');
    }
  });

  it('redacts every shape in a mixed body instead of short-circuiting on the first', () => {
    // 兼容网关可能同时带 messages 与 input；短路写法会漏掉后半部分。
    const mixed = {
      messages: [{ role: 'tool', tool_call_id: 'c1', content: INCIDENT_TOOL_RESULT_TEXT }],
      input: [{ type: 'function_call_output', call_id: 'c2', output: INCIDENT_TOOL_RESULT_TEXT }],
    };
    const out = redactToolResultPayloadsInBody(mixed);
    expect(out).not.toBeNull();
    const serialized = JSON.stringify(out);
    expect(serialized.match(/646a 4577/g)).toBeNull();
    expect(serialized).toContain('sha256');
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
    const body = anthropicBody(INCIDENT_TOOL_RESULT_TEXT);
    body.messages = [...(body.messages as unknown[]), { role: 'user', content: '继续' }];
    const out = redactToolResultPayloadsInBody(body);
    expect(out).not.toBeNull();
    expect(JSON.stringify(out)).not.toContain('646a 4577');
  });
});
