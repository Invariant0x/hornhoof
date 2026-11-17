import { expect, type Locator, type Page } from '@playwright/test';

/* Design's rules for a department's outbound setup (#989), as what breaks them in the part as drawn: an empty list when
   all hold. statuses: the words of every status; danger: the names of the buttons that stop or take back, which the part
   must show; entryBlocks: the headings of the blocks whose entries stand apart. */
export type Words = { statuses: string[]; danger: string[]; entryBlocks: string[] };

export async function offences(panel: Locator, words: Words): Promise<string[]> {
  return panel.evaluate((root, words) => {
    const out: string[] = [];
    const css = (el: Element) => getComputedStyle(el);
    const rect = (el: Element) => el.getBoundingClientRect();
    const px = (value: string) => parseFloat(value) || 0;
    const name = (el: Element) => `${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 40)}"`;
    const rtl = css(root).direction === 'rtl';

    /* 1. A group of buttons ends at the end edge of its line. */
    for (const group of new Set([...root.querySelectorAll('button')].map(b => b.parentElement!))) {
      const edges = [...group.children].filter(c => c.tagName === 'BUTTON').map(rect);
      const short = rtl ? Math.min(...edges.map(e => e.left)) - rect(group).left : rect(group).right - Math.max(...edges.map(e => e.right));
      if (Math.abs(short) > 1) out.push(`1: ${name(group)} ends ${Math.round(short)}px before its end`);
    }

    /* 2. A status stands alone, in a frame. */
    const statuses = [...root.querySelectorAll('*')].filter(el => el.children.length === 0 && words.statuses.includes((el.textContent ?? '').trim()));
    if (!statuses.length) out.push('2: no status stands alone');
    for (const el of statuses) if (css(el).borderTopStyle !== 'solid' || px(css(el).borderTopWidth) < 1) out.push(`2: ${name(el)} has no frame`);

    /* 3. A button that stops or takes back is pink, and the last of its group. */
    const probe = document.createElement('span');
    probe.style.color = 'var(--pink-ink)';
    root.append(probe);
    const pink = css(probe).color;
    probe.remove();
    const danger = [...root.querySelectorAll('button')].filter(b => words.danger.includes((b.textContent ?? '').trim()));
    if (words.danger.length && !danger.length) out.push('3: no button that stops or takes back');
    for (const b of danger) {
      if (css(b).color !== pink) out.push(`3: ${name(b)} is ${css(b).color}, not ${pink}`);
      if (b.nextElementSibling?.tagName === 'BUTTON') out.push(`3: ${name(b)} is not the last of its group`);
    }

    /* 4. A list keeps nothing of the browser's: no marker, no indent, no margin. */
    for (const list of root.querySelectorAll('ul, ol')) {
      const s = css(list);
      if (s.listStyleType !== 'none' || px(s.paddingInlineStart) !== 0 || px(s.marginTop) !== 0 || px(s.marginBottom) !== 0) out.push(`4: ${name(list)} keeps the browser's list look`);
    }

    /* 5. Revisions and log entries stand 16px apart, with a line from the second on. */
    const blocks = [...root.querySelectorAll('section')].filter(section => words.entryBlocks.includes(section.querySelector('h4')?.textContent ?? ''));
    if (blocks.length !== words.entryBlocks.length) out.push(`5: ${blocks.length} of ${words.entryBlocks.length} blocks found`);
    for (const list of blocks.flatMap(b => [...b.querySelectorAll('ul')])) {
      const items = [...list.children];
      items.slice(1).forEach((item, i) => {
        const gap = rect(item).top - rect(items[i]!).bottom;
        if (Math.abs(gap - 16) > 1 || px(css(item).borderTopWidth) !== 1 || Math.abs(px(css(item).paddingTop) - 16) > 0.5) out.push(`5: ${name(item)} stands ${Math.round(gap)}px after the one before`);
      });
    }

    /* 6. No line begins with a dot: no dot starts a piece of text or follows a space a line may break at. */
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (/(^|[ \t\n\r])·/.test((node as Text).data)) out.push(`6: "${(node as Text).data.slice(0, 40)}" may begin a line with a dot`);

    /* 7. A block's heading is no weaker than a card's: the display face, 600, 15px. */
    const cardHeading = root.querySelector('.imp h3');
    for (const h of root.querySelectorAll('section > h4')) {
      const s = css(h);
      if (s.fontSize !== '15px' || s.fontWeight !== '600' || (cardHeading && s.fontFamily !== css(cardHeading).fontFamily)) out.push(`7: ${name(h)} is ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`);
    }

    /* 9 and 10. A form has one edge: its groups have no frame of the browser and their fields line up with the others;
       its box is drawn the same in every browser. */
    for (const form of root.querySelectorAll('form')) {
      for (const set of form.querySelectorAll('fieldset')) {
        const s = css(set);
        if (px(s.borderTopWidth) || px(s.paddingInlineStart) || px(s.paddingInlineEnd)) out.push(`9: ${name(set)} keeps the browser's frame`);
        /* Its heading stands 4px above what follows it, whether a browser lays the legend out as a legend or not. */
        const legend = set.querySelector('legend');
        const next = legend && set.querySelector('legend ~ * > :first-child, legend + :not(div)');
        const gap = legend && next ? rect(next).top - rect(legend).bottom : NaN;
        if (Math.abs(gap - 4) > 1) out.push(`9: ${name(set)} has ${Math.round(gap)}px under its heading`);
      }
      const fields = [...form.querySelectorAll('input:not([type=checkbox]), select, legend')].map(rect);
      const lefts = fields.map(f => Math.round(f.left));
      const rights = fields.map(f => Math.round(f.right));
      if (fields.length && (Math.max(...lefts) - Math.min(...lefts) > 1 || Math.max(...rights) - Math.min(...rights) > 1)) out.push(`10: ${name(form)} has fields on ${new Set(lefts).size} edges`);
      for (const box of form.querySelectorAll('input[type=checkbox]')) {
        const s = css(box) as CSSStyleDeclaration & { webkitAppearance?: string };
        const look = s.appearance || s.webkitAppearance;
        if (look !== 'none' || Math.round(rect(box).width) !== 16 || Math.round(rect(box).height) !== 16) out.push(`9: the box is ${look} ${rect(box).width}x${rect(box).height}`);
      }
      /* A number is typed as text: no arrows of the browser, which each browser draws its own way. */
      for (const field of form.querySelectorAll('input[type=number]')) {
        const s = css(field) as CSSStyleDeclaration & { webkitAppearance?: string; MozAppearance?: string };
        const look = s.appearance || s.webkitAppearance || s.MozAppearance;
        if (look !== 'textfield') out.push(`9: ${name(field)} keeps the arrows of ${look}`);
      }
    }

    /* 11. A channel's caption: how and to whom on one line, limits and sending on the next. */
    for (const caption of root.querySelectorAll('.imp header p')) {
      const lines = [...caption.children].map(rect);
      lines.slice(1).forEach((line, i) => {
        if (line.top < lines[i]!.bottom - 1) out.push(`11: ${name(caption)} runs its pieces on one line`);
      });
    }

    /* 12. Entries break a word only where it does not fit a line; a long address may break anywhere. */
    for (const li of root.querySelectorAll('li')) if (css(li).overflowWrap !== 'break-word') out.push(`12: ${name(li)} breaks words ${css(li).overflowWrap}`);
    const addresses = root.querySelectorAll('bdi');
    if (root.querySelector('li') && !addresses.length) out.push('12: no address stands apart');
    for (const bdi of addresses) if (css(bdi).overflowWrap !== 'anywhere') out.push(`12: ${name(bdi)} breaks ${css(bdi).overflowWrap}`);

    /* 13. A phrase isolated in its own direction lines up with the side of its block, not with its own start: on a right
       to left page an English description stands right like its heading (Design #1186). */
    if (rtl) for (const el of root.querySelectorAll('[dir="auto"]')) if (css(el).display === 'block' && ['left', 'start'].includes(css(el).textAlign)) out.push(`13: ${name(el)} stands ${css(el).textAlign} in ${css(el.parentElement!).direction} ${css(el.parentElement!).textAlign}`);
    return out;
  }, words);
}

/* Where the part's column starts and ends on the page, to compare one browser with another. */
export async function edges(panel: Locator): Promise<{ left: number; right: number }> {
  return panel.evaluate(el => {
    const box = el.getBoundingClientRect();
    return { left: Math.round(box.left), right: Math.round(box.right) };
  });
}

/* Nothing sideways: the page and the panel take their width, and no line or button sticks out of its card. */
export async function fits(page: Page, panel: Locator) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await panel.evaluate(el => [...el.querySelectorAll('.imp, .repo-actions, .imp-meta, li, h3, h4, p')].filter(n => (n as HTMLElement).scrollWidth > (n as HTMLElement).clientWidth + 1).length)).toBe(0);
}

/* Every field, list and button of the part is a touch target of 44px, as in the Settings window: what is smaller. */
export async function small(panel: Locator) {
  return panel.evaluate(root => [...root.querySelectorAll('input:not([type=checkbox]), select, button')].flatMap(el => {
    const high = Math.round(el.getBoundingClientRect().height);
    const fits = el.tagName === 'BUTTON' ? high >= 44 : high === 44;
    return fits ? [] : [`${el.tagName} ${(el.textContent ?? '').trim()} ${high}`];
  }));
}

/* What a person sees with this part of the panel scrolled into view, as a picture in dir. */
export const shooter = (dir: string) => async (page: Page, what: Locator, file: string) => {
  await what.evaluate(el => el.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: `${dir}/${file}.png`, animations: 'disabled' });
};
