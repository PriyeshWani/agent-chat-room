export const version = 4;

export function up(db) {
  db.exec(`
    CREATE TABLE hub_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO hub_settings SELECT 'local_owner', id FROM owners ORDER BY created_at,id LIMIT 1;
    CREATE TABLE invitations (
      id TEXT PRIMARY KEY NOT NULL, token_hash TEXT UNIQUE NOT NULL,
      room_id TEXT NOT NULL REFERENCES rooms(id), owner_id TEXT NOT NULL REFERENCES owners(id),
      created_by TEXT NOT NULL REFERENCES participants(id),
      kind TEXT NOT NULL CHECK(kind IN ('human','agent')), label TEXT NOT NULL,
      expires_at TEXT NOT NULL, revoked_at TEXT, used_key TEXT, used_payload TEXT, result_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX invitations_room ON invitations(room_id);
    CREATE TABLE room_access (
      owner_id TEXT NOT NULL REFERENCES owners(id), room_id TEXT NOT NULL REFERENCES rooms(id),
      invitation_id TEXT NOT NULL REFERENCES invitations(id), PRIMARY KEY(owner_id,room_id)
    );
    CREATE TABLE agent_scopes (
      participant_id TEXT PRIMARY KEY NOT NULL REFERENCES participants(id),
      room_id TEXT NOT NULL REFERENCES rooms(id), invitation_id TEXT NOT NULL REFERENCES invitations(id)
    );
  `);
}
