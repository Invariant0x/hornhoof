# Preparation note for Task 7, not a launch brief

Do not start Task7 until Task6 is accepted and committed and the actual base is filled into its generated brief.

R6.1 says live sessions stay after key rotation. This includes a today's legacy tunnel using its original30s heartbeat settings. Current plugin_decide authenticates Ping with the session's original metas.key, so a key update alone would cut that existing legacy session at its next Ping. Cover actual legacy traffic through a heartbeat after rotation as well as the plan's network-client test; preserve ban/free refusal and the old key's refusal at every public API and new Login. Resolve implementation within Task7 allowed files, without broadening the contract or printing credentials. This is a reminder of the existing live-session requirement, not a new ruling or permission to weaken authentication.

The new authenticated key update must also preserve the existing binding-lifetime ownership rule: a request authorized before release/rebind must not overwrite the next owner key. Recheck the authorizing hash in the update, with a failing local authorization/write race regression first. This follows the existing lifetime guards, not a request for TaskA1 chosen-key support.
