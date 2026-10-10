ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_conversation_order_idx
  ON messages(conversation_id, created_at, id);
