import type { Locator } from '@playwright/test';
import { pseudo } from './whole-text-data';

/* A text left as it is: one already stretched, in the brackets of the pseudo translation, or only spaces. */
const KEPT = /⟦|^\s*$/;
const longer = (text: string) => (KEPT.test(text) ? text : pseudo(text.trim()));

/* Each text of an element, in order. It runs in the page. */
function textsOf(el: Element): string[] {
  const all: string[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(); node; node = walk.nextNode()) all.push(node.textContent!);
  return all;
}

/* Writes each text of an element anew, in the same order. It runs in the page. */
function writeTexts(el: Element, texts: string[]) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walk.nextNode(), i = 0; node; node = walk.nextNode(), i++) node.textContent = texts[i]!;
}

/* No pseudo-long language ships, so a test keeps its own (Design #1656): each text of the block in the long pseudo
   translation, about twice as long as the English. A text already stretched stays as it is, so a block stretched in one
   state and then partly drawn again is stretched once. The page's clock stands still in between, so nothing redraws the
   block while its texts are read and written. */
export async function stretch(block: Locator) {
  const texts = await block.evaluate(textsOf);
  await block.evaluate(writeTexts, texts.map(longer));
}
