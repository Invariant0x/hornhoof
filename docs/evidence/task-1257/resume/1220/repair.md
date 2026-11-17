# Current assistant-removal caller

Task 1220 replaces changedBy with employeeChangedBy for employee-history writes. Since its accepted base, iv-people-delete added removeAssistantAgent and another agent_changes write in apps/server/src/modules/assistants/setup.ts. The mechanical replay preserved that new call but its old changedBy name no longer had an import.

On 1ac8c84433a3ad619144f0a6a0d4b3e7f69b653c, server test types reported TS2304 at line 139. The existing people-delete.test.ts then reproduced a real failure: deleting an assistant returned 500 instead of 204, with 7 other cases passed and exit 1. Both raw failures are saved.

The repair changes this one incoming employee-history call to employeeChangedBy. It preserves person/orchestrator attribution and gives the new nullable actingAgentId field the same handling as the other employee-history writes. It changes no route permission or deletion behavior. The final named checks include people-delete.test.ts and repeat the task 1220 scope after this code change.
