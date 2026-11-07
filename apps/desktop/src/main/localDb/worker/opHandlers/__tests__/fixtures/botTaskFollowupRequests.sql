-- Target test fixture only. Production schema/migration is owned by the data author.
CREATE TABLE bot_task_followup_requests (
  task_id TEXT NOT NULL REFERENCES bot_delegations(id) ON DELETE CASCADE,
  requester_bot_id TEXT NOT NULL,
  key_digest TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  input_id TEXT NOT NULL UNIQUE,
  admitted_run_sequence INTEGER NOT NULL CHECK (admitted_run_sequence >= 1),
  child_session_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('admitted', 'dispatching', 'unknown', 'settled')),
  native_accepted_at INTEGER,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, requester_bot_id, key_digest)
);
