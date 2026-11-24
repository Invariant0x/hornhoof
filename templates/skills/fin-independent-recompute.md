---
id: fin-independent-recompute
kind: gate
sources: [anthropics/financial-services managed-agent-cookbooks/README.md]
---
A check is worth something only when the checker did not make the work and does not trust it until it is rebuilt.

1. Get the deliverable and the list of source records it claims to use. Do not read the maker's workings or explanations before step 3.
2. From the source records alone (bank statements, invoices, billing exports, contracts, the trial balance), use SQL or a script to recompute the key numbers yourself: totals, balances, the main formulas, every figure in the summary. A model's reading of the maker's numbers is not recomputation.
3. Compare your numbers with the deliverable. A difference above the tolerance your head set is a finding. Only now read the maker's workings to find where the two paths split.
4. Check what recomputing alone misses: the right period, sign and currency; every source included; nothing counted twice; text that matches the numbers; assumptions labelled as assumptions.
5. For anything that leaves the company (statements, figures for investors, banks or tax, invoices, payment lists), every key number must match before you pass it.

Verdict, in your report:
- **PASS**: the numbers you recomputed and how they match.
- **FAIL**: each finding with the expected value, the value found, the source, and where the difference arises.

While checking, never fix the work you check; findings go back to the maker through your head. Never pass work you could not recompute; say what was missing. This restriction concerns this check, not a different implementation assignment. Report the verdict to the owner of the next action. A person makes the payment or signature.
