export const version = 1;

export function up(db) {
  db.exec(`
    CREATE TABLE owners (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE participants (
      id TEXT PRIMARY KEY NOT NULL,
      owner_id TEXT NOT NULL REFERENCES owners(id),
      kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
      name TEXT NOT NULL, runtime TEXT, workspace_json TEXT,
      context TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX participants_owner ON participants(owner_id);
    CREATE TABLE agent_bindings (
      participant_id TEXT PRIMARY KEY NOT NULL REFERENCES participants(id),
      resume_hash TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL CHECK(generation >= 0)
    );
    CREATE TABLE connections (
      id TEXT PRIMARY KEY NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id),
      generation INTEGER NOT NULL CHECK(generation >= 0),
      token_hash TEXT NOT NULL UNIQUE, boot_id TEXT NOT NULL,
      created_at TEXT NOT NULL, closed_at TEXT
    );
    CREATE INDEX connections_participant ON connections(participant_id);
    CREATE TABLE session_requests (
      resume_hash TEXT NOT NULL REFERENCES agent_bindings(resume_hash),
      request_id TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(resume_hash, request_id)
    );
    CREATE TABLE browser_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL, token_value TEXT NOT NULL,
      participant_id TEXT NOT NULL REFERENCES participants(id)
    );
    CREATE INDEX browser_sessions_participant ON browser_sessions(participant_id);
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, goal TEXT NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence >= 1), created_at TEXT NOT NULL
    );
    CREATE TABLE memberships (
      room_id TEXT NOT NULL REFERENCES rooms(id),
      participant_id TEXT NOT NULL REFERENCES participants(id),
      epoch TEXT NOT NULL UNIQUE, active INTEGER NOT NULL CHECK(active IN (0, 1)),
      joined_sequence INTEGER NOT NULL CHECK(joined_sequence >= 0),
      acknowledged_sequence INTEGER NOT NULL CHECK(acknowledged_sequence >= joined_sequence),
      paused INTEGER NOT NULL CHECK(paused IN (0, 1)),
      PRIMARY KEY(room_id, participant_id)
    );
    CREATE INDEX memberships_participant ON memberships(participant_id, active);
    CREATE TABLE events (
      id TEXT PRIMARY KEY NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id),
      sequence INTEGER NOT NULL CHECK(sequence >= 1),
      author_id TEXT NOT NULL REFERENCES participants(id), author_name TEXT NOT NULL,
      author_kind TEXT NOT NULL CHECK(author_kind IN ('human', 'agent')),
      text TEXT NOT NULL, reply_to TEXT, created_at TEXT NOT NULL,
      UNIQUE(room_id, sequence), UNIQUE(room_id, id),
      FOREIGN KEY(room_id, reply_to) REFERENCES events(room_id, id)
    );
    CREATE TABLE requests (
      participant_id TEXT NOT NULL REFERENCES participants(id), request_id TEXT NOT NULL,
      operation TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT NOT NULL,
      PRIMARY KEY(participant_id, request_id)
    );
    CREATE TABLE batches (
      id TEXT PRIMARY KEY NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id),
      participant_id TEXT NOT NULL REFERENCES participants(id), membership_epoch TEXT NOT NULL,
      scanned_through INTEGER NOT NULL CHECK(scanned_through >= 0), events_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending', 'acked', 'invalidated')), created_at TEXT NOT NULL,
      FOREIGN KEY(room_id, participant_id) REFERENCES memberships(room_id, participant_id)
    );
    CREATE UNIQUE INDEX batches_one_pending ON batches(room_id, participant_id) WHERE status = 'pending';
    CREATE INDEX batches_membership_epoch ON batches(membership_epoch);
  `);
}
