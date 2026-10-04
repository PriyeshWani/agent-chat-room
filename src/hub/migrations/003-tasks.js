export const version = 3;

export function up(db) {
  db.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    title TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('proposed','in_progress','blocked','in_review','completed','cancelled')),
    created_by TEXT NOT NULL REFERENCES participants(id),
    owner_id TEXT REFERENCES participants(id),
    source_message_id TEXT,
    worker_ref TEXT, latest_update TEXT NOT NULL, result TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    CHECK((status = 'proposed' AND owner_id IS NULL) OR (status <> 'proposed' AND owner_id IS NOT NULL)),
    FOREIGN KEY(room_id, source_message_id) REFERENCES events(room_id, id)
  );
  CREATE INDEX tasks_room_updated ON tasks(room_id, updated_at);
  CREATE INDEX tasks_owner_status ON tasks(owner_id, status);`);
}
