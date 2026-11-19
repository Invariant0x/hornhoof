---
id: fin-spreadsheet-audit
title: { en: "Spreadsheet audit", ru: "Проверка таблиц" }
description: { en: "Checks a model or spreadsheet for broken formulas, hidden numbers and wrong links.", ru: "Проверяет модель или таблицу на сломанные формулы, спрятанные числа и неверные ссылки." }
kind: checklist
sources: [anthropics/financial-services plugins/agent-plugins/model-builder/skills/audit-xls/SKILL.md]
---
Use the assigned workbook, its source records, period, units and tolerance. You must not be its maker. Go through it sheet by sheet and record each problem with its sheet and cell. Keep any stress changes in a disposable copy, not the deliverable being checked.

- **Structure**: inputs, calculations and outputs are separate; every input is on the inputs sheet; no hidden sheets, rows or columns carry numbers.
- **Typed numbers in formulas**: a constant inside a calculation (=B4*1.2) is a finding unless it is a documented unit conversion.
- **Consistency**: one formula across a row or column; a cell that differs from its neighbours is a finding until explained.
- **References**: no links to other files, no references to empty cells, no ranges that miss the last row or month, no circular references unless deliberate and documented.
- **Errors**: no #REF!, #DIV/0!, #N/A or #VALUE! anywhere, hidden cells included; no IFERROR that masks a real problem.
- **Checks**: the balance sheet balances every period, the cash flow ties to the change in cash, subtotals add up to totals.
- **Units and signs**: currency and units in labels, costs with one consistent sign, percentages stored as fractions.
- **Dates**: period labels match the data; no month is shifted.
- **Stress**: set a main input to zero and then double it; outputs should move the way the business would, with no errors.

Report the problems ranked by how much they change an output, with the corrected value where you can compute it.

Preserve the checked workbook. Give findings to the maker with the exact figures, source records and observed discrepancies.
