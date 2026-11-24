## What changes

<!-- What a person using Hornhoof gets from this, in plain words. Link the issue: "Closes #123". -->

## How I checked it

<!-- The tests you added, and what you ran. For a screen: screenshots in English and in the longest and the shortest other language of the registry, and at phone width. -->

## Checklist

- [ ] The new test failed before the change and passes after it.
- [ ] `npm test` passes, and `npx tsc -p <part>/tsconfig.json --noEmit` for each part I changed.
- [ ] New screen text is in `en.ts`, the source, and in the file of every other language of the registry, in plain words.
- [ ] No em dashes, and "е" instead of "ё" in Russian.
- [ ] I reformatted no file I did not change.
- [ ] Every commit has a `Signed-off-by` line (`git commit -s`).
