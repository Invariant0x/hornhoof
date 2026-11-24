-- Who may get in now, read from the database a restore replaces, after cutover.sql in the same session: the restored
-- database brings back no person who was disabled or removed since, no machine that was disconnected, no key that was
-- replaced and no assistant's or node's key that was revoked, cleared or replaced. With it, who holds the company's data
-- now, and the link as the relay takes it now with the secrets of the peer services, each sealed as it is stored: a
-- machine that stopped holding the data holds it no more after a restore, and a key or a secret it knew opens nothing.
-- And the key the company's files are sealed with, with how many machines keep each: a database from before the store,
-- or before its first file, has no key, and one made then would open none of the files the machines keep. And the area
-- each machine gives the files, none included, as its owner set it. The store's tables and columns are read by name, so
-- the carry of a database from before them says none. One line of JSON.
SELECT jsonb_build_object(
  'people', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', p.id, 'status', p.status, 'passwordHash', p.password_hash, 'scopeKind', p.scope_kind, 'isOwner', p.is_owner, 'isCeoDelegate', p.is_ceo_delegate,
      'removedAt', to_jsonb(p)->'removed_at', 'removedName', CASE WHEN to_jsonb(p)->>'removed_at' IS NOT NULL THEN p.name END,
      'access', COALESCE((SELECT jsonb_agg(jsonb_build_object('departmentId', a.department_id, 'teamId', a.team_id)) FROM person_access a WHERE a.person_id = p.id), '[]'::jsonb)))
    FROM people p), '[]'::jsonb),
  'invites', COALESCE((SELECT jsonb_agg(token_hash) FROM invites WHERE used_at IS NULL AND expires_at > now()), '[]'::jsonb),
  'machines', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'revoked', revoked_at IS NOT NULL, 'lendsTests', lends_tests, 'keepsBackups', keeps_backups,
      'computerClosed', to_jsonb(m)->'computer_closed', 'role', role, 'dataLeftAt', data_left_at, 'uploadState', upload_state)
      || CASE WHEN to_jsonb(m) ? 'file_store_limit_bytes' THEN jsonb_build_object('fileStoreLimitBytes', to_jsonb(m)->'file_store_limit_bytes') ELSE '{}'::jsonb END) FROM machines m), '[]'::jsonb),
  'link', (SELECT jsonb_build_object('name', name, 'url', url, 'hidden', hidden, 'keyEnc', key_enc, 'nextKeyEnc', next_key_enc, 'tunnelEnc', tunnel_enc, 'createdAt', created_at) FROM public_links LIMIT 1),
  'peerSecrets', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'secretEnc', secret_enc, 'createdAt', created_at)) FROM peer_secrets), '[]'::jsonb),
  'serials', COALESCE((SELECT jsonb_agg(serial) FROM certificates WHERE revoked_at IS NOT NULL), '[]'::jsonb),
  'revokedSerials', COALESCE((SELECT jsonb_agg(jsonb_build_object('serial', serial, 'until', expires) ORDER BY serial)
    FROM (SELECT serial, max(expires) AS expires FROM (
      SELECT serial, "until" AS expires FROM certificates WHERE revoked_at IS NOT NULL AND "until" > now()
      UNION ALL
      SELECT serial, "until" AS expires FROM revoked_certificate_serials WHERE "until" > now()
    ) AS live_revocations GROUP BY serial) AS revoked), '[]'::jsonb),
  'recoveryKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'recipient', recipient, 'linkPrint', link_print, 'linkName', link_name, 'linkUrl', link_url, 'madeBy', made_by, 'madeAt', created_at, 'retiredAt', retired_at))
    FROM recovery_keys), '[]'::jsonb),
  'assistantKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('personId', person_id, 'keyHash', key_hash, 'keyCreatedAt', key_created_at, 'wakeSecretEnc', wake_secret_enc))
    FROM assistants WHERE key_hash IS NOT NULL), '[]'::jsonb),
  'nodeKeys', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'keyHash', key_hash)) FROM nodes WHERE key_hash IS NOT NULL), '[]'::jsonb),
  'fileKeyEnc', CASE WHEN to_regclass('net.file_key') IS NOT NULL THEN (SELECT (xpath('/row/key_enc/text()', x))[1]::text
      FROM query_to_xml('SELECT key_enc FROM net.file_key LIMIT 1', false, true, '') AS x WHERE x::text <> '') END,
  'fileCopies', CASE WHEN to_regclass('net.file_settings') IS NOT NULL THEN (SELECT jsonb_build_object('copies', (xpath('/row/copies/text()', x))[1]::text::int,
      'setBy', (xpath('/row/set_by/text()', x))[1]::text) FROM query_to_xml('SELECT copies, set_by FROM net.file_settings LIMIT 1', false, true, '') AS x
      WHERE x::text <> '') END);
