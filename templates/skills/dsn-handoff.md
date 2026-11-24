---
id: dsn-handoff
kind: procedure
sources: [anthropics/knowledge-work-plugins design/skills/design-handoff/SKILL.md]
---
Prepare the design package named in the assignment so a builder can implement it without inventing decisions.

1. **Design reference**. Choose a format the builder and checker can open on the supported surfaces. Preserve inspectable behavior, content, layout and all relevant states, themes and languages.
2. **Specification**, per screen:
   - User task and position in the flow.
   - System component names and variants.
   - Proposed system additions or exceptions, their owner and approval state.
   - Control behavior, validation, slow responses and errors.
   - Interface text in each language, with string keys when used.
   - Focus order, accessible names and screen-reader announcements.
   - Long content, wrapping, grouped actions and layout at narrow and wide widths.
3. **Open decisions**: unresolved questions, each with a proposal and the decision maker required by the task.
4. **Evidence**: open the mockups at phone and desktop widths in supported languages and themes; attach screenshots and list unverified states. Use the approved route for any browser test suite.

Return the package to the task's recipient with its system version, scope and known gaps. Follow the company's authorized cross-department route for questions. Any independent check is assigned by task gates; author inspection does not replace it when required.
