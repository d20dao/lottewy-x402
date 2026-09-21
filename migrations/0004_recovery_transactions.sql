CREATE TABLE recovery_transactions(
  operation_id TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
  raw_tx TEXT NOT NULL,tx_hash TEXT NOT NULL,tx_nonce INTEGER NOT NULL,
  reserved_units INTEGER NOT NULL,release_block INTEGER,created INTEGER NOT NULL,
  PRIMARY KEY(operation_id,kind)
);
CREATE INDEX recovery_pending ON recovery_transactions(status,created);
