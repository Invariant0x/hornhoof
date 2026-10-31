-- The red team checks logic and flows; the protection plan belongs to security.
UPDATE "agents" SET "skills" = "skills" - 'dev-threat-model' WHERE "role_key" = 'DEV-RED';
