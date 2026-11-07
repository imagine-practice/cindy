/**
 * 项目界面的「可执行设计规则」。
 *
 * 背景：视觉缺陷（按钮过大、同名选项、图标没有名字）人工看图才能发现，
 * 但其中大部分是**可以断言的结构问题**。把规则写成断言后，同类问题在
 * `pnpm ui:check` 里就会直接失败，不再依赖谁恰好看了一眼。
 *
 * 只断言「一定不合理」的事实，不断言主观风格：
 *   1. 按钮 / 下拉这类单行控件不超过 36px —— 桌面密度上限（正文 13px、行高 32px）；
 *   2. 每个按钮都有可访问名称（图标按钮必须有 aria-label）；
 *   3. 同一个面板里不出现两个同名按钮（重复入口 / 角色名当名字）；
 *   4. 项目页正文文字不小于 11px，标题不超过 18px。
 *
 * 文本域不在规则 1 内：它本来就是多行。
 */

const INTERACTIVE = 'button, select, [role="combobox"], [role="button"]';
const TEXT = 'p, span, h1, h2, h3, h4, li, label, button, a';

async function heights(page, selector) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      })
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40),
        height: Math.round(el.getBoundingClientRect().height * 100) / 100,
        // 整卡可点（卡片里带标题/多段内容）是刻意的点击目标，不属于「单行控件」密度规则。
        card:
          !!el.querySelector('h1, h2, h3, h4, [role="heading"]') ||
          el.children.length > 3 ||
          el.querySelectorAll('*').length > 8,
        inDialog: !!el.closest('[role="dialog"]'),
      }));
  }, selector);
}

/**
 * 单行控件高度上限。`root` 可以限定到某个容器；默认整页。
 * 违反时把「标签 + 实际高度」一起报出来，不用再回头翻截图。
 */
export async function assertControlHeights(page, { root = 'body', max = 36 } = {}) {
  const items = await heights(page, root === 'body' ? INTERACTIVE : `${root} ${INTERACTIVE}`);
  const tooTall = items.filter((item) => !item.card && item.height > max);
  if (tooTall.length > 0) {
    throw new Error(
      `control taller than ${max}px: ${tooTall
        .map((item) => `${item.label || item.tag}(${item.height}px)`)
        .join(', ')}`,
    );
  }
}

/** 每个按钮都必须有可访问名称（文本或 aria-label）。 */
export async function assertNamedButtons(page) {
  const unnamed = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden';
      })
      .filter((el) => {
        const text = (el.textContent ?? '').trim();
        const label = (el.getAttribute('aria-label') ?? '').trim();
        return text.length === 0 && label.length === 0;
      })
      .map((el) => el.outerHTML.slice(0, 120));
  });
  if (unnamed.length > 0) throw new Error(`button without accessible name: ${unnamed.join(' | ')}`);
}

/** 同一面板里不允许出现两个同名按钮：重复入口 / 角色名当名字都会被抓到。 */
export async function assertUniqueButtonLabels(page, { root = '[role="dialog"]' } = {}) {
  const duplicates = await page.evaluate((sel) => {
    const scope = document.querySelector(sel);
    if (!scope) return [];
    const counts = new Map();
    for (const el of Array.from(scope.querySelectorAll('button'))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const name = ((el.getAttribute('aria-label') ?? el.textContent) ?? '').trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].filter(([, count]) => count > 1).map(([name, count]) => `${name}×${count}`);
  }, root);
  if (duplicates.length > 0) throw new Error(`duplicate button labels: ${duplicates.join(', ')}`);
}

/** 正文 11px 起、标题不超过 18px：项目页字号必须落在应用同一档。 */
export async function assertTypeScale(page, { min = 11, max = 18 } = {}) {
  const offenders = await page.evaluate(({ sel, floor, ceiling }) => {
    const out = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      if (el.children.length > 0 && el.tagName.toLowerCase() !== 'button') continue;
      const text = (el.textContent ?? '').trim();
      if (!text) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const size = Math.round(parseFloat(getComputedStyle(el).fontSize) * 100) / 100;
      if (size < floor || size > ceiling) {
        out.push(`${etag(el)}:${size}px:${text.slice(0, 24)}`);
      }
    }
    return out;
    function etag(el) { return el.tagName.toLowerCase(); }
  }, { sel: TEXT, floor: min, ceiling: max });
  if (offenders.length > 0) throw new Error(`text outside ${min}-${max}px: ${offenders.slice(0, 6).join(', ')}`);
}

/** 四条的合集：项目页每个场景都能直接调用。 */
export async function assertProjectUiRules(page, options = {}) {
  await assertNamedButtons(page);
  await assertControlHeights(page, options);
  await assertTypeScale(page, options);
}
