---
id: dsn-visual-qa
kind: procedure
sources: []
---
Compare the built screens named in the assignment with approved mockups and the current design system. Record the exact build and scope; do not treat a mockup as proof of the implementation.

1. Open the product at phone, tablet and desktop widths, in every supported language and theme in scope. Capture screenshots with their width, locale and state.
2. Compare each with its approved reference for layout, spacing, type, colour, icons and text.
3. Inspect representative elements for approved tokens and components rather than one-off values.
4. Exercise empty, loading, error, partial-data, long-text and many-item states using test data, never real customer data.
5. Check hover, focus, active and disabled states and the visible result of each main action.
6. Check complete wrapping of long content and action groups at narrow and wide widths. Nothing should be hidden, clipped or truncated to conceal overflow.
7. Classify findings as broken (the task fails), wrong (differs from the approved reference) or polish (minor drift). Record missing evidence and untested states separately.

Return a verdict and findings with screenshot, build, width, language, expected result and observation. Pass this check only when no broken or wrong finding remains and required checks were actually performed. Use the approved route for browser test suites.

When assigned an independent check, use a checker other than the author and do not edit the screens or code under review. This review scope does not prevent implementing a different assigned change. Follow the task's recipients and gates.
