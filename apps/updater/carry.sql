-- Who may get in now, read from the database a restore replaces, after cutover.sql in the same session: the restored
-- database brings back no person who was disabled or removed since, no machine that was disconnected and no key that was
-- replaced. With it, who holds the company's data now, and the link as the relay takes it now with the secrets of the
-- peer services, each sealed as it is stored: a machine that stopped holding the data holds it no more after a restore,
-- and a key or a secret it knew opens nothing. One line of JSON.
SELECT jsonb_build_object(
  'people', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'status', p.status, 'passwordHash', p.password_hash, 'scopeKind', p.scope_kind, 'isOwner', p.is_owner, 'isCeoDelegate', p.is_ceo_delegate,
      'removedAt', to_jsonb(p)->'removed_at', 'removedName', CASE WHEN to_jsonb(p)->>'removed_at' IS NOT NULL THEN p.name END,
      'access', COALESCE((SELECT jsonb_agg(jsonb_build_object('departmentId', a.department_id, 'teamId', a.team_id)) FROM person_access a WHERE a.person_id = p.id), '[]'::jsonb)))
    FROM people p), '[]'::jsonb),
  'invites', COALESCE((SELECT jsonb_agg(token_hash) FROM invites WHERE used_at IS NULL AND expires_at > now()), '[]'::jsonb),
  'machines', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'revoked', revoked_at IS NOT NULL, 'lendsTests', lends_tests, 'keepsBackups', keeps_backups,
      'computerClosed', to_jsonb(m)->'computer_closed', 'role', role, 'dataLeftAt', data_left_at, 'uploadState', upload_state)) FROM machines m), '[]'::jsonb),
  'link', (SELECT jsonb_build_object('name', name, 'url', url, 'hidden', hidden, 'keyEnc', key_enc, 'nextKeyEnc', next_key_enc, 'tunnelEnc', tunnel_enc, 'createdAt', created_at) FROM public_links LIMIT 1),
  'peerSecrets', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'secretEnc', secret_enc, 'createdAt', created_at)) FROM peer_secrets), '[]'::jsonb),
  'serials', COALESCE((SELECT jsonb_agg(serial) FROM certificates WHERE revoked_at IS NOT NULL), '[]'::jsonb),
  'recoveryKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'recipient', recipient, 'linkPrint', link_print, 'linkName', link_name, 'linkUrl', link_url, 'madeBy', made_by, 'madeAt', created_at, 'retiredAt', retired_at))
    FROM recovery_keys), '[]'::jsonb));
