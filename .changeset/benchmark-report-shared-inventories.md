---
"@ai-hero/sandcastle": minor
---

Emit benchmark report JSON version 2 with shared candidate path inventories to avoid repeating large source trees in every assessment and export. Candidate `paths` fields now hold an `inventorySha256` reference, resolved through the report's `candidateInventories` table; CSV uses the same references. Offline HTML downloads include the complete table.
