-- Who may get in now, read from the database a restore replaces, after cutover.sql in the same session: the restored
-- database brings back no person who was disabled since, no machine that was disconnected and no key that was
-- replaced. One line of JSON.
SELECT jsonb_build_object(
  'people', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'status', p.status, 'passwordHash', p.password_hash, 'scopeKind', p.scope_kind, 'isOwner', p.is_owner,
      'access', COALESCE((SELECT jsonb_agg(jsonb_build_object('departmentId', a.department_id, 'teamId', a.team_id)) FROM person_access a WHERE a.person_id = p.id), '[]'::jsonb)))
    FROM people p), '[]'::jsonb),
  'invites', COALESCE((SELECT jsonb_agg(token_hash) FROM invites WHERE used_at IS NULL AND expires_at > now()), '[]'::jsonb),
  'machines', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'revoked', revoked_at IS NOT NULL, 'lendsTests', lends_tests, 'keepsBackups', keeps_backups)) FROM machines), '[]'::jsonb),
  'serials', COALESCE((SELECT jsonb_agg(serial) FROM certificates WHERE revoked_at IS NOT NULL), '[]'::jsonb),
  'recoveryKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'recipient', recipient, 'linkPrint', link_print, 'linkName', link_name, 'linkUrl', link_url, 'madeBy', made_by, 'madeAt', created_at, 'retiredAt', retired_at))
    FROM recovery_keys), '[]'::jsonb));
