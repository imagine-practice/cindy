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
 * 真实的代码损坏。所以这里只认**高置信度**的秘密形态与**二进制转储**，其余一律不动。
 *
 * **缓存契约**（与 `replaceToolResultImagesWithNotice` 同款）：无改动 → 返回 null →
 * 代理字节透传。有改动时也必须**确定性** —— 摘要用内容哈希而非时间戳，同一段历史在
 * 每一轮得到同一个替换结果，prompt cache 前缀因此保持稳定。
 *
 * **已知取舍**（review 后收紧判据时定下的边界，改动前请先读）：
 *  - 转储判定要求「偏移 + 等宽十六进制组 + 组数 ≥ 6 + （多行时）偏移等距递增」。
 *    纯数字表格（TSV / CSV / `column -t`）组宽不是 2/4/8，因此不再误判。
 *    残留风险：`objdump` 里罕见的长指令行（≥6 字节原始码）仍会被判为转储；notice
 *    给出的补救是「重跑并只打印摘要」，反汇编场景可加 `--no-show-raw-insn`。
 *  - 凭据判定只认**厂商形态**：带 `proj-`/`ant-` 段的 `sk-/pk-/rk-` 要求同时含数字与
 *    大写且主体 ≥32 字符；`ghp_`/`github_pat_`/`xox?-`/`AKIA|ASIA`/`AIza` 按各家规格。
 *    刻意不收「任何以 sk/pk/rk 开头的下划线标识符」——那会把
 *    `pk_orders_customer_id_index` 这类 SQL 索引名、`ASIA_PACIFIC_*` 常量抹掉，
 *    模型再把被抹过的片段写回文件就是真实的数据损坏。
 *  - 摘要里带 `sha256(被剥离内容)` 前 16 位。对高熵密钥无实际风险；对被剥离的
 *    低熵容器（dotenv / 固定格式配置）理论上构成离线比对 oracle，但换来的是
 *    「重跑同一命令能否得到同一段字节」的可验证性。这是刻意取舍，不是疏漏。
 */

import { createHash } from 'node:crypto';

import type { RequestTransform } from './types.js';

/** 与同目录 transform.ts 保持同名同实现的本地助手（该目录不跳包边界导入）。 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 单个 tool 输出文本的上限（字符，UTF-16 code unit 计）。与
 * `packages/lizi-mcps/src/lsp/_shared.ts` 的 `MAX_OUTPUT_CHARS` 取同一量级：常见的
 * 整文件读取远小于它，而撞 48MB body 上限（#7995，413 后会话永久锁死）的累积型
 * 输出会被这里提前削平。
 */
export const TOOL_RESULT_TEXT_MAX_CHARS = 100_000;
/** 截断后保留的头部（近期上下文最常被引用）。 */
const KEEP_HEAD_CHARS = 70_000;
/** 截断后保留的尾部（尾部常有命令的最终结论与错误）。 */
const KEEP_TAIL_CHARS = 25_000;

// ── 十六进制转储判定 ───────────────────────────────────────────────────────────
/** 偏移 + 至少一个字节组；更严格的判定在 `parseDumpLine` 里做。 */
const HEX_OFFSET_AND_REST = /^\s*(?:0x)?([0-9a-fA-F]{4,16}):?(?:[ \t]+)(.*)$/;
/** 十六进制字节组的合法宽度（字符数）：1/2/4 字节。 */
const DUMP_GROUP_WIDTHS = new Set([2, 4, 8]);
/** 一行至少要有的字节组数。低于它的行不算转储行（`objdump` 的短指令行因此排除）。 */
const DUMP_MIN_GROUPS = 6;
/** 单行即可判定为转储的最低组数（一整行 16 字节转储的常见形态）。 */
const DUMP_STRONG_GROUPS = 8;

interface DumpLine {
  offset: number;
  /** 字节组的字符宽度。 */
  width: number;
  count: number;
}

/**
 * 解析一行十六进制转储。不是转储一律返回 null。
 *
 * 判据刻意都选「转储独有、纯数字表格不具备」的性质：
 *  1. 所有字节组**等宽**，且宽度 ∈ {2, 4, 8}。TSV / CSV / `column -t` 的数值列宽
 *     是 3 位或不定宽，直接被挡掉 —— 这是最容易误伤的一类真实输入。
 *  2. 组数 ≥ 6。`objdump` 的多数指令行只有 2–5 字节原始码，因此不命中。
 */
function parseDumpLine(line: string): DumpLine | null {
  const match = HEX_OFFSET_AND_REST.exec(line);
  if (!match) return null;
  const offset = Number.parseInt(match[1]!, 16);
  if (!Number.isFinite(offset)) return null;
  const tokens = match[2]!.split(/[ \t]+/).filter((token) => token.length > 0);
  const groups: string[] = [];
  for (const token of tokens) {
    if (!/^[0-9a-fA-F]+$/.test(token)) break;
    groups.push(token);
  }
  if (groups.length < DUMP_MIN_GROUPS) return null;
  const width = groups[0]!.length;
  if (!DUMP_GROUP_WIDTHS.has(width)) return null;
  if (!groups.every((group) => group.length === width)) return null;
  return { offset, width, count: groups.length };
}

/** 一段连续行是否构成转储：单行足够宽，或多行且偏移按固定步长递增。 */
function isDumpRun(parsed: DumpLine[]): boolean {
  if (parsed.length === 0) return false;
  if (parsed.some((line) => line.count >= DUMP_STRONG_GROUPS)) return true;
  if (parsed.length < 2) return false;
  // 步长必须等于「组数 × 每组的字节数」，且全程一致 —— 转储的强结构证据。
  const step = parsed[0]!.count * (parsed[0]!.width / 2);
  if (step <= 0) return false;
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index]!.offset - parsed[index - 1]!.offset !== step) return false;
  }
  return true;
}

function sha256Short(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function dumpNotice(lines: number, bytes: number, digest: string): string {
  // 命令必须给出**两种 shell** 的形态：Pi 的 `bash`（Windows 上是 MSYS/bash）与
  // `powershell` 是两个并列的内置工具，同一台机器上都能用（`packages/maker-core`
  // 的审批层也是 `toolName === 'bash' || toolName === 'powershell'` 一并处理）。
  // 只写 POSIX 形态会让 PowerShell 会话拿到一条跑不通的指引。
  //
  // 这里**不**按工具名分叉文案：出站层看不到工具名，要靠 tool_use_id 反查调用方，
  // 会引入漏关联/错关联的新失败面，而换来的只是措辞差异。给全两种形态同样可执行。
  return `[binary/hex dump omitted by Cindy before sending: ${lines} line(s), ${bytes} bytes, sha256 ${digest}. `
    + 'Raw binary and credential dumps are stripped outbound because upstream content review rejects them; '
    + 'this turn would fail otherwise. Do not reconstruct or guess the bytes. To identify a file, print only '
    + 'a digest instead of dumping it — bash: `sha256sum <file>` + `wc -c <file>`; PowerShell: '
    + '`Get-FileHash <file>` + `(Get-Item <file>).Length`. Avoid `Format-Hex` / `xxd` on secrets. '
    + 'For disassembly add `--no-show-raw-insn`.';
}

/**
 * 把连续的十六进制转储行替换成一条摘要。
 *
 * 只替换命中的行段，行段之外的文本（`=== 文件头 ===` 这类标题、报错、普通输出）原样
 * 保留 —— 排查价值来自那些上下文，不需要为脱敏牺牲它。行尾的 `\r` 只参与判定、不参与
 * 输出：CRLF 的 tool 输出（Windows 上 PowerShell 系命令的常态）此前会因为 `$` 卡在
 * `\r` 之前而整段漏检。
 */
function redactHexDumpRuns(text: string): string | null {
  const lines = text.split('\n');
  const out: string[] = [];
  let changed = false;
  let index = 0;
  while (index < lines.length) {
    const parsed = parseDumpLine(lines[index]!.replace(/\r+$/, ''));
    if (!parsed) {
      out.push(lines[index]!);
      index += 1;
      continue;
    }
    // 收集一段连续的转储候选行。
    const run: DumpLine[] = [];
    let end = index;
    while (end < lines.length) {
      const candidate = parseDumpLine(lines[end]!.replace(/\r+$/, ''));
      if (!candidate) break;
      run.push(candidate);
      end += 1;
    }
    if (!isDumpRun(run)) {
      out.push(...lines.slice(index, end));
      index = end;
      continue;
    }
    const removed = lines.slice(index, end).join('\n');
    out.push(dumpNotice(run.length, Buffer.byteLength(removed, 'utf8'), sha256Short(removed)));
    changed = true;
    index = end;
  }
  return changed ? out.join('\n') : null;
}

// ── 凭据字面量 ────────────────────────────────────────────────────────────────

const REDACTED_SECRET = '[REDACTED_BY_CINDY]';
const PEM_OMITTED =
  '[private key block omitted by Cindy before sending: it was removed from this tool output. '
  + 'Do not reconstruct or guess it. If you need to identify the key, report its fingerprint '
  + '(e.g. `ssh-keygen -lf <file>`) instead of its bytes.]';

/** PEM / OpenSSH / PGP 私钥：标签宽度放宽，`PRIVATE KEY BLOCK` 是 PGP 装甲的形态。 */
const PRIVATE_KEY_LABEL = '[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?';
/**
 * 私钥块：优先匹配「BEGIN…END 成对」，否则把 BEGIN 到文本末尾整段吃掉。
 *
 * 为什么必须带孤立 BEGIN 分支：`head -3 ~/.ssh/id_ed25519`、`sed -n 1,5p`、`base64`
 * 这类常见读法只有 BEGIN 没有 END，此前完全漏脱敏（成对规则不成立 → 身体是 base64，
 * 也不命中 hexdump / JWT / 厂商前缀）。按「宁可多抹、不可漏」整段移除。
 *
 * 为什么两条分支写在**同一个正则**里：分两遍 replace 时，成对规则会在「很多 BEGIN、
 * 没有 END」的输入上每个起点都惰性展开到串尾（O(k·n)）；单一正则里孤立分支一旦命中就
 * 吃掉剩余整段，外层随即结束，整体回到线性。
 */
const PRIVATE_KEY_BLOCK = new RegExp(
  `-----BEGIN ${PRIVATE_KEY_LABEL}-----(?:[\\s\\S]*?-----END ${PRIVATE_KEY_LABEL}-----|[\\s\\S]*$)`,
  'g',
);

/** JWT（header.payload.signature 三段）。 */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
/**
 * 厂商密钥形态。每条都对应该厂商公开的 key 形状，不做「模糊前缀 + 长度」的泛匹配：
 * 泛匹配会把 `pk_orders_customer_id_index`（SQL 索引名）、`ASIA_PACIFIC_REGION_ENDPOINT`
 * 之类的普通标识符抹掉，而模型随后可能把被抹过的片段写回文件。
 */
const PREFIXED_SECRETS: readonly RegExp[] = [
  // OpenAI / Stripe / 通用：`sk-`、`sk-proj-`、`sk-ant-`；要求含数字与大写且主体 ≥32。
  /\b(?:sk|pk|rk)-(?:proj-|ant-)?(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{32,}/g,
  // Stripe 显式环境段：`sk_live_` / `sk_test_` / `pk_live_` / `rk_test_` …
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  // GitHub：`ghp_` / `gho_` / `ghs_` / `ghu_` 个人与 App token。
  /\bgh[pous]_[A-Za-z0-9]{20,}\b/g,
  // GitHub fine-grained PAT。
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Slack：`xoxb-` / `xoxp-` / `xoxa-` / `xoxr-` / `xoxs-`。
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // AWS 访问密钥 id：恰好 16 位大写字母与数字（`ASIA_PACIFIC_*` 常量因此不命中）。
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Google API key。
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
];
/** `Authorization: Bearer <长串>`（curl -v 等工具输出里的常见泄露面）。 */
const BEARER_HEADER = /\b((?:proxy-)?authorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/=-]{20,}/gi;

/** 抹掉高置信度的凭据字面量。 */
function redactSecretLiterals(text: string): string | null {
  let next = text;
  next = next.replace(PRIVATE_KEY_BLOCK, PEM_OMITTED);
  next = next.replace(BEARER_HEADER, `$1${REDACTED_SECRET}`);
  next = next.replace(JWT, REDACTED_SECRET);
  for (const pattern of PREFIXED_SECRETS) next = next.replace(pattern, REDACTED_SECRET);
  return next === text ? null : next;
}

// ── 超大输出截断 ──────────────────────────────────────────────────────────────

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 超限输出按「头 + 标记 + 尾」压缩，标记里写明被省略的字符数。 */
function truncateOversized(text: string): string | null {
  if (text.length <= TOOL_RESULT_TEXT_MAX_CHARS) return null;
  let headEnd = KEEP_HEAD_CHARS;
  // 不要从代理对中间切开（emoji / 罕见汉字），否则尾半会变成孤立代理。
  if (headEnd < text.length && isHighSurrogate(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  let tailStart = text.length - KEEP_TAIL_CHARS;
  if (tailStart > 0 && isLowSurrogate(text.charCodeAt(tailStart))) tailStart += 1;
  const omitted = tailStart - headEnd;
  return `${text.slice(0, headEnd)}\n\n`
    + `[… ${omitted} characters omitted by Cindy outbound size limit; total ${text.length} characters. `
    + 'Read the file in smaller ranges or filter the output if you need the middle …]\n\n'
    + text.slice(tailStart);
}

/**
 * 处理单个 tool 输出文本。返回 null 表示无需改动（保持字节透传 / 缓存稳定）。
 *
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

// ── 三种协议形状 ──────────────────────────────────────────────────────────────

/** Responses 的 tool 输出块用 `input_text` / `output_text`；Anthropic 与 chat 用 `text`。 */
const TEXT_BLOCK_TYPES = new Set(['text', 'input_text', 'output_text']);
/** Responses 里带 tool 输出的 item 类型。 */
const RESPONSES_OUTPUT_ITEM_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
  'computer_call_output',
]);

/** 改写 content 数组里各 text 块的正文。 */
function redactInnerContent(content: unknown[]): { content: unknown[]; changed: boolean } {
  let changed = false;
  const next = content.map((inner) => {
    if (!isPlainObject(inner)) return inner;
    if (typeof inner.type !== 'string' || !TEXT_BLOCK_TYPES.has(inner.type)) return inner;
    if (typeof inner.text !== 'string') return inner;
    const redacted = redactToolResultText(inner.text);
    if (redacted === null) return inner;
    changed = true;
    return { ...inner, text: redacted };
  });
  return { content: next, changed };
}

/** 改写一个「正文可能是字符串、也可能是 text 块数组」的容器。 */
function redactContainer(
  container: Record<string, unknown>,
  field: 'content' | 'output',
): Record<string, unknown> | null {
  const value = container[field];
  if (typeof value === 'string') {
    const redacted = redactToolResultText(value);
    return redacted === null ? null : { ...container, [field]: redacted };
  }
  if (!Array.isArray(value)) return null;
  const inner = redactInnerContent(value);
  return inner.changed ? { ...container, [field]: inner.content } : null;
}

/** 按 predicate 选中条目并改写，其余原样保留。 */
function mapSelected(
  items: unknown[],
  predicate: (item: Record<string, unknown>) => boolean,
  rewrite: (item: Record<string, unknown>) => Record<string, unknown> | null,
): { items: unknown[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    if (!isPlainObject(item) || !predicate(item)) return item;
    const rewritten = rewrite(item);
    if (rewritten === null) return item;
    changed = true;
    return rewritten;
  });
  return { items: next, changed };
}

/** Anthropic Messages：`messages[].content[]` 中 `type === 'tool_result'` 的块。 */
function redactAnthropicToolResults(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(body.messages)) return null;
  const { items, changed } = mapSelected(
    body.messages,
    (message) => Array.isArray(message.content),
    (message) => {
      const { items: content, changed: contentChanged } = mapSelected(
        message.content as unknown[],
        (block) => block.type === 'tool_result',
        (block) => redactContainer(block, 'content'),
      );
      return contentChanged ? { ...message, content } : null;
    },
  );
  return changed ? { ...body, messages: items } : null;
}

/** OpenAI chat completions：`messages[]` 中 `role === 'tool'`（及 legacy `function`）。 */
function redactChatToolMessages(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.messages)) return null;
  const { items, changed } = mapSelected(
    body.messages,
    (message) => message.role === 'tool' || message.role === 'function',
    (message) => redactContainer(message, 'content'),
  );
  return changed ? { ...body, messages: items } : null;
}

/** Responses：`input[]` 中的 tool 输出项。 */
function redactResponsesToolOutputs(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;
  const { items, changed } = mapSelected(
    body.input,
    (item) => typeof item.type === 'string' && RESPONSES_OUTPUT_ITEM_TYPES.has(item.type),
    (item) => redactContainer(item, 'output'),
  );
  return changed ? { ...body, input: items } : null;
}

/**
 * 对三种协议形状**依次**净化，只碰 tool 输出，不碰用户/助手正文 —— 用户自己的话与模型
 * 自己的回复不做任何改写。
 *
 * 三种形状各自取数，不会互相遮蔽；但仍然串行累加而不是「第一个非 null 就返回」：
 * 混合 body（同一请求同时带 `messages` 与 `input` 的兼容网关）时短路会漏掉后半部分，
 * 而这个前提没有任何断言能守住。三个都返回 null 才是 null。
 */
export function redactToolResultPayloadsInBody(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  const afterChat = (() => {
    const afterAnthropic = redactAnthropicToolResults(body);
    const base = afterAnthropic ?? body;
    const chat = redactChatToolMessages(base);
    return { body: chat ?? base, changed: afterAnthropic !== null || chat !== null };
  })();
  const responses = redactResponsesToolOutputs(afterChat.body);
  if (responses !== null) return responses;
  return afterChat.changed ? afterChat.body : null;
}

/**
 * 请求 transform：默认 fail-open（不给 `errorMode`），净化抛错时该步被跳过、请求照常
 * 发出 —— #2018 的验收要求「hook 不可用时会话可正常运行」，脱敏是防线而不是硬门槛。
 */
export const redactToolResultPayloads: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;
  return redactToolResultPayloadsInBody(body);
};
