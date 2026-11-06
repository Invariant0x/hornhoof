---
id: dsn-visual-qa
title: { en: "Visual check of built screens", ru: "Визуальная проверка экранов" }
description: { en: "Compares built screens with the approved mockups and the design system at several widths and in every language the product supports.", ru: "Сравнивает готовые экраны с утвержденными макетами и дизайн-системой на разной ширине и на всех языках продукта." }
kind: procedure
sources: []
---
Check the built product, not the mockup, as a batch of the screens development reports done for a product.

1. Open the screen in a browser at phone, tablet and desktop widths, in every language the product supports and in each theme it has. Screenshot each.
2. Put each screenshot next to the approved mockup. List the differences in layout, spacing, type, colour, icons and text.
3. Check the system: inspect a few elements; they should use the system's tokens and components, not one-off values.
4. Check the states you can reach: empty, loading, error, long text, many items. Trigger them with test data, never with real customer data.
5. Check the interactions: hover, focus, disabled, and what happens after each main action.
6. Sort findings by impact: broken (the task cannot be done), wrong (differs from the approved design), polish (small drift).

Report each finding with its screenshot, width and language, what was expected and what you saw. Pass only when nothing broken or wrong is left. You check; you do not fix the code.
