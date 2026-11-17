/* A command as its code shows it. Each flag of it stands in a piece of its own, so it never breaks at its hyphens; the
   command is then the text of the whole code rather than of one piece, and this finds it so. */
export const commandCode = (text: string) => (_: string, element: Element | null): boolean => element?.tagName === 'CODE' && element.textContent === text;
