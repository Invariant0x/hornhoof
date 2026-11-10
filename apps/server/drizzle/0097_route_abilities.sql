-- A route now names the skill whoever checks at each stage must carry. The routes made before this named none:
-- every one of them went through the stages of Development, so they get its skills.
UPDATE "task_routes" SET "state" = "state" || jsonb_build_object('abilities', CASE WHEN jsonb_array_length("state"->'stages') > 0
  THEN '{"review":"dev-review-diff","cleanup":"dev-cleanup","security":"dev-security-review","tests":"dev-test-environment"}'::jsonb
  ELSE '{}'::jsonb END)
WHERE NOT ("state" ? 'abilities');
