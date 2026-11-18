# Current assistant-removal caller

Historical task report. Raw files named here are preserved in `task-1364-source-evidence.tar.gz`, attached to task 1364, with per-file SHA-256 values in `archive-manifest.json`. [Original report and neighboring artifacts](https://github.com/invariant0x/hornhoof/blob/509b469f086cf28f63ec4799ad6187498bf96da0/docs/evidence/task-1257/resume/1220/repair.md). These are historical results, not checks of the current release.

Task 1220 replaces changedBy with employeeChangedBy for employee-history writes. Since its accepted base, iv-people-delete added removeAssistantAgent and another agent_changes write in apps/server/src/modules/assistants/setup.ts. The mechanical replay preserved that new call but its old changedBy name no longer had an import.

On 1ac8c84433a3ad619144f0a6a0d4b3e7f69b653c, server test types reported TS2304 at line 139. The existing people-delete.test.ts then reproduced a real failure: deleting an assistant returned 500 instead of 204, with 7 other cases passed and exit 1. Both raw failures are saved.

The repair changes this one incoming employee-history call to employeeChangedBy. It preserves person/orchestrator attribution and gives the new nullable actingAgentId field the same handling as the other employee-history writes. It changes no route permission or deletion behavior. The final named checks include people-delete.test.ts and repeat the task 1220 scope after this code change.
