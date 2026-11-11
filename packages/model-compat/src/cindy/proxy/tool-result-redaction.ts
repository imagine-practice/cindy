/**
 * 出站 tool 结果净化 —— 请求发往模型之前，把「不该进模型上下文」的载荷换成可诊断摘要。
 *
 * **为什么在出站这一层**（而不是在工具执行后）：代理每轮看到的是**完整历史**，所以
 * 这里做一层，既覆盖本轮新产生的 tool_result，也覆盖历史里已经存在的那条。被上游
 * 内容审核拒绝过的会话因此可以在下一次发送时自愈，不需要用户手工回退或改转录 ——
 * 这是工具侧脱敏做不到的（工具侧只能拦住未来的输出，历史已经被毒化）。
 *
 * **两类真实事故**（本模块的 pattern 与阈值都以它们为据，不凭推测加）：
 *  - 2026-11-11：Agent 排查登录问题时用 `bash` 读了凭据文件的 hexdump，3 行
 *    `00000000: 646a 4577 …` 进入 tool_result，**1 ms 后**下一轮请求被供应商输入
 *    内容安全审核确定性拒绝（`data_inspection_failed`，HTTP 400）。Pi 的会话转录
 *    永久保留该 tool_result 并每轮重发，于是原会话此后每轮都命中同一拒绝。
 *  - #2018：Pi `tool_result` 出站前既无凭证脱敏也无大输出截断，只有读侧路径有拦截。
 *
 * **为什么不用既有 `redactSensitiveText` 全量套在 tool 输出上**：它按
 * `token|key|secret: value` 这种通用形态抹值，而 tool 输出常常是**源码**。把
 * `token: string` 这类字段值抹成占位符后，模型可能把被抹过的片段写回文件，造成
 * 真实的代码损坏。所以这里只认**高置信度**的秘密形态（PEM 私钥、JWT、带厂商前缀的
 * 密钥字面量、Authorization bearer）与**二进制转储**，其余一律不动。
 *
 * **缓存契约**（与 `replaceToolResultImagesWithNotice` 同款）：无改动 → 返回 null →
 * 代理字节透传。有改动时也必须**确定性** —— 摘要用内容哈希而非时间戳，同一段历史在
 * 每一轮得到同一个替换结果，prompt cache 前缀因此保持稳定。
 */

import { createHash } from 'node:crypto';

import type { RequestTransform } from './types.js';

/** 与同目录 transform.ts 保持同名同实现的本地助手（该目录不跳包边界导入）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 单个 tool 输出文本的上限（字符）。与 `packages/lizi-mcps/src/lsp/_shared.ts` 的
 * `MAX_OUTPUT_CHARS` 取同一量级：常见的整文件读取远小于它，而撞 48MB body 上限
 * （#7995，413 后会话永久锁死）的累积型输出会被这里提前削平。
 */
export const TOOL_RESULT_TEXT_MAX_CHARS = 100_000;
/** 截断后保留的头部（近期上下文最常被引用）。 */
const KEEP_HEAD_CHARS = 70_000;
/** 截断后保留的尾部（尾部常有命令的最终结论与错误）。 */
const KEEP_TAIL_CHARS = 25_000;

/** 十六进制转储的偏移前缀 + 至少 3 组十六进制字节（xxd / od / hexdump 的常见形态）。 */
const HEX_DUMP_LINE = /^\s*(?:0x)?[0-9a-fA-F]{4,16}:?(?:\s+[0-9a-fA-F]{2,8}){3,}(?:\s{2,}.*)?$/;
/** 单行即可判定为转储的最低字节组数（少于它就要靠连续多行才成立）。 */
const HEX_DUMP_STRONG_GROUPS = 5;
/** 弱形态（3–4 组）需要连续行数才判定为转储，避免误伤零散的十六进制数值。 */
const HEX_DUMP_MIN_RUN_LINES = 2;

/** PEM 私钥块：命中即整块移除（不可能有正当理由把它送进模型上下文）。 */
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
/** JWT（header.payload.signature 三段）。 */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/** 带厂商前缀的密钥字面量。只认已知前缀，避免把普通标识符抹掉。 */
const PREFIXED_SECRET =
  /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[baprs]|AKIA|ASIA|AIza)[-_A-Za-z0-9]{16,}\b/g;
/** `Authorization: Bearer <长串>`（curl -v 等工具输出里的常见泄露面）。 */
const BEARER_HEADER = /\b((?:proxy-)?authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi;

const REDACTED_SECRET = '[REDACTED_BY_CINDY]';
const PEM_OMITTED =
  '[private key block omitted by Cindy before sending: it was removed from this tool output. '
  + 'Do not reconstruct or guess it. If you need to identify the key, report its fingerprint '
  + '(e.g. `ssh-keygen -lf <file>`) instead of its bytes.]';

function sha256Short(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function hexGroupCount(line: string): number {
  const afterOffset = line.replace(/^\s*(?:0x)?[0-9a-fA-F]{4,16}:?\s*/, '');
  return afterOffset.trim().split(/\s+/).filter((token) => /^[0-9a-fA-F]{2,8}$/.test(token)).length;
}

function dumpNotice(lines: number, bytes: number, digest: string): string {
  return `[binary/hex dump omitted by Cindy before sending: ${lines} line(s), ${bytes} bytes, sha256 ${digest}. `
    + 'Raw binary and credential dumps are stripped outbound because upstream content review rejects them; '
    + 'this turn would fail otherwise. Do not reconstruct or guess the bytes. If you need to identify the '
    + 'value, re-run the command and print only a digest (e.g. `sha256sum <file>`, `wc -c <file>`).]';
}

/**
 * 把连续的十六进制转储行替换成一条摘要。
 * 只替换命中的行段，行段之外的文本（例如 `=== 文件头 ===` 这类标题、报错、普通输出）
 * 原样保留 —— 排查价值来自那些上下文，不需要为脱敏牺牲它。
 */
function redactHexDumpRuns(text: string): string | null {
  if (!/^\s*(?:0x)?[0-9a-fA-F]{4,16}:?/m.test(text)) return null;
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    if (!HEX_DUMP_LINE.test(lines[index]!)) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    // 收集一段连续的可疑行。
    let end = index;
    let strong = false;
    while (end < lines.length && HEX_DUMP_LINE.test(lines[end]!)) {
      if (hexGroupCount(lines[end]!) >= HEX_DUMP_STRONG_GROUPS) strong = true;
      end += 1;
    }
    const runLines = lines.slice(index, end);
    const isDump = strong || runLines.length >= HEX_DUMP_MIN_RUN_LINES;
    if (!isDump) {
      out.push(...runLines);
      index = end;
      continue;
    }
    const removed = runLines.join('\n');
    out.push(dumpNotice(runLines.length, Buffer.byteLength(removed, 'utf8'), sha256Short(removed)));
    changed = true;
    index = end;
  }
  return changed ? out.join('\n') : null;
}

/** 抹掉高置信度的凭据字面量。 */
function redactSecretLiterals(text: string): string | null {
  let next = text;
  next = next.replace(PEM_PRIVATE_KEY, PEM_OMITTED);
  next = next.replace(BEARER_HEADER, `$1${REDACTED_SECRET}`);
  next = next.replace(JWT, REDACTED_SECRET);
  next = next.replace(PREFIXED_SECRET, REDACTED_SECRET);
  return next === text ? null : next;
}

/** 超限输出按「头 + 标记 + 尾」压缩，标记里写明被省略的字符数。 */
function truncateOversized(text: string): string | null {
  if (text.length <= TOOL_RESULT_TEXT_MAX_CHARS) return null;
  const omitted = text.length - KEEP_HEAD_CHARS - KEEP_TAIL_CHARS;
  return `${text.slice(0, KEEP_HEAD_CHARS)}\n\n`
    + `[… ${omitted} characters omitted by Cindy outbound size limit; total ${text.length} characters. `
    + 'Read the file in smaller ranges or filter the output if you need the middle …]\n\n'
    + text.slice(-KEEP_TAIL_CHARS);
}

/**
 * 处理单个 tool 输出文本。返回 null 表示无需改动（保持字节透传 / 缓存稳定）。
 * 顺序固定：先凭据与转储，再截断 —— 否则超长转储会先被截断，摘要里那半段字节反而留在
 * 上下文里，既没脱敏也没截干净。
 */
export function redactToolResultText(text: string): string | null {
  if (!text) return null;
  let changed = false;
  let next = redactSecretLiterals(text);
  if (next !== null) {
    changed = true;
  } else {
    next = text;
  }
  const withoutDump = redactHexDumpRuns(next);
  if (withoutDump !== null) {
    next = withoutDump;
    changed = true;
  }
  const truncated = truncateOversized(next);
  if (truncated !== null) {
    next = truncated;
    changed = true;
  }
  return changed ? next : null;
}

/** 就地改写 tool_result 的 inner content 数组（Anthropic / Responses 两种块类型）。 */
function redactInnerContent(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((inner) => {
    if (!isPlainObject(inner)) return inner;
    // Anthropic 与 chat completions 用 `text`；Responses 的 tool 输出块用 `input_text` / `output_text`。
    // 只认 `text` 会漏掉整条 Responses 路径。
    if (inner.type !== 'text' && inner.type !== 'input_text' && inner.type !== 'output_text') return inner;
    if (typeof inner.text !== 'string') return inner;
    const redacted = redactToolResultText(inner.text);
    if (redacted === null) return inner;
    changed = true;
    return { ...inner, text: redacted };
  });
  return { content: next, changed };
}

/** Anthropic Messages：`messages[].content[]` 中 `type === 'tool_result'` 的块。 */
function redactAnthropicToolResults(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isPlainObject(message) || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const nextContent = message.content.map((block) => {
      if (!isPlainObject(block) || block.type !== 'tool_result') return block;
      // inner content 既可能是字符串，也可能是 text 块数组。
      if (typeof block.content === 'string') {
        const redacted = redactToolResultText(block.content);
        if (redacted === null) return block;
        messageChanged = true;
        return { ...block, content: redacted };
      }
      if (!Array.isArray(block.content)) return block;
      const inner = redactInnerContent(block.content);
      if (!inner.changed) return block;
      messageChanged = true;
      return { ...block, content: inner.content };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content: nextContent };
  });
  return changed ? { ...body, messages: nextMessages } : null;
}

/** OpenAI chat completions：`messages[]` 中 `role === 'tool'` 的输出。 */
function redactChatToolMessages(body: Record<string, unknown>): Record<string, unknown> | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isPlainObject(message) || message.role !== 'tool') return message;
    if (typeof message.content === 'string') {
      const redacted = redactToolResultText(message.content);
      if (redacted === null) return message;
      changed = true;
      return { ...message, content: redacted };
    }
    if (!Array.isArray(message.content)) return message;
    const inner = redactInnerContent(message.content);
    if (!inner.changed) return message;
    changed = true;
    return { ...message, content: inner.content };
  });
  return changed ? { ...body, messages: nextMessages } : null;
}

/** Responses：`input[]` 中的 function/custom tool 输出项。 */
function redactResponsesToolOutputs(body: Record<string, unknown>): Record<string, unknown> | null {
  const input = body.input;
  if (!Array.isArray(input)) return null;
  let changed = false;
  const nextInput = input.map((item) => {
    if (!isPlainObject(item)) return item;
    if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') return item;
    if (typeof item.output === 'string') {
      const redacted = redactToolResultText(item.output);
      if (redacted === null) return item;
      changed = true;
      return { ...item, output: redacted };
    }
    if (!Array.isArray(item.output)) return item;
    const inner = redactInnerContent(item.output);
    if (!inner.changed) return item;
    changed = true;
    return { ...item, output: inner.content };
  });
  return changed ? { ...body, input: nextInput } : null;
}

/**
 * 对三种协议形状依次尝试净化。只碰 tool 输出，不碰用户/助手正文 —— 用户自己的话与
 * 模型自己的回复不做任何改写。
 *
 * 返回 null 表示三种形状都没有可改内容（代理据此走字节透传）。
 */
export function redactToolResultPayloadsInBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const anthropic = redactAnthropicToolResults(body);
  if (anthropic !== null) return anthropic;
  const chat = redactChatToolMessages(body);
  if (chat !== null) return chat;
  return redactResponsesToolOutputs(body);
}

/**
 * 请求 transform：默认 fail-open（不给 `errorMode`），净化抛错时该步被跳过、请求照常
 * 发出 —— #2018 的验收要求「hook 不可用时会话可正常运行」，脱敏是防线而不是硬门槛。
 */
export const redactToolResultPayloads: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;
  return redactToolResultPayloadsInBody(body);
};
