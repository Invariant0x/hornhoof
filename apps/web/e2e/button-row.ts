import { expect, type Locator } from '@playwright/test';

type Place = { name: string; left: number; right: number; top: number } | null;

/* The named buttons of a form stand in one row, in that order, and the row ends at the form's end edge: its right in left
   to right, its left in right to left. Read from where each button is on the screen, so a wrapped row or a row at the
   start edge shows as it looks. */
export async function inOneRowAtEnd(form: Locator, names: readonly string[]) {
  const { rtl, start, end, places } = await form.evaluate((element, names) => {
    const style = getComputedStyle(element);
    const frame = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('button')];
    return {
      rtl: style.direction === 'rtl',
      start: frame.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      end: frame.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
      places: names.map((name): Place => {
        const button = buttons.find(b => b.textContent?.trim() === name);
        if (!button) return null;
        const box = button.getBoundingClientRect();
        return { name, left: box.left, right: box.right, top: box.top };
      }),
    };
  }, names);
  for (const [i, place] of places.entries()) expect(place, `${names[i]} is in the form`).not.toBeNull();
  const row = places as NonNullable<Place>[];
  for (const place of row.slice(1)) expect(Math.abs(place.top - row[0]!.top), `${place.name} stands in the row of ${row[0]!.name}`).toBeLessThanOrEqual(1);
  for (const [i, place] of row.slice(1).entries()) {
    const before = row[i]!;
    if (rtl) expect(place.right, `${place.name} follows ${before.name} to the left`).toBeLessThanOrEqual(before.left);
    else expect(place.left, `${place.name} follows ${before.name} to the right`).toBeGreaterThanOrEqual(before.right);
  }
  const last = row.at(-1)!;
  if (rtl) expect(Math.abs(last.left - start), `${last.name} ends the row at the left edge`).toBeLessThanOrEqual(1);
  else expect(Math.abs(last.right - end), `${last.name} ends the row at the right edge`).toBeLessThanOrEqual(1);
}
