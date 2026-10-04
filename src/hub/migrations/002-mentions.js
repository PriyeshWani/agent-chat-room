export const version = 2;

export function up(db) {
  db.exec("ALTER TABLE events ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'");
}
