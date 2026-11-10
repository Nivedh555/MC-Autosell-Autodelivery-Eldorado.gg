                                                                            

CREATE TABLE IF NOT EXISTS account_pairs (
  id TEXT PRIMARY KEY,
  pair_index INTEGER NOT NULL UNIQUE,
  buyer_id TEXT,
  buyer_ign TEXT,
  buyer_email TEXT,
  seller_id TEXT,
  seller_ign TEXT,
  seller_email TEXT,
  accumulated_balance REAL NOT NULL DEFAULT 0,
  threshold REAL NOT NULL DEFAULT 3000000000,
  state TEXT NOT NULL DEFAULT 'BELOW_THRESHOLD',
  current_order_id TEXT,
  locked_at TEXT,
  disabled INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_pairs_state ON account_pairs(state);

                                                               
ALTER TABLE marketplace_orders ADD COLUMN proof_image_path TEXT;
ALTER TABLE marketplace_orders ADD COLUMN pre_balance REAL;
ALTER TABLE marketplace_orders ADD COLUMN post_balance REAL;
ALTER TABLE marketplace_orders ADD COLUMN delivery_tx_data TEXT;
ALTER TABLE marketplace_orders ADD COLUMN assigned_pair_id TEXT;
ALTER TABLE marketplace_orders ADD COLUMN cancelled_at TEXT;
ALTER TABLE marketplace_orders ADD COLUMN cancel_reason TEXT;

                                                      
CREATE TABLE IF NOT EXISTS order_chat_messages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  is_automated INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_order_id ON order_chat_messages(order_id);
