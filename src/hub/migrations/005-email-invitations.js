export const version = 5;

export function up(db) {
  db.exec(`CREATE TABLE invitation_emails (
    id TEXT PRIMARY KEY NOT NULL,
    invitation_id TEXT NOT NULL REFERENCES invitations(id),
    participant_id TEXT NOT NULL REFERENCES participants(id),
    room_id TEXT NOT NULL REFERENCES rooms(id),
    message_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','failed','unknown')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX invitation_emails_rate ON invitation_emails(participant_id, created_at);`);
}
