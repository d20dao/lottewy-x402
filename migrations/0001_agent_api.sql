CREATE TABLE json_chunks(object_key TEXT NOT NULL,part INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(object_key,part));
CREATE TABLE operations(
 id TEXT PRIMARY KEY,owner TEXT NOT NULL,commitment TEXT NOT NULL,payment_key TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL,public_json TEXT NOT NULL,created INTEGER NOT NULL,
 amount TEXT NOT NULL,payment_network TEXT NOT NULL,payment_ref TEXT NOT NULL,
 settlement_json TEXT,review_json TEXT NOT NULL,reserved_units INTEGER NOT NULL,release_block INTEGER,
 tx_hash TEXT,raw_tx TEXT,tx_nonce INTEGER,request_id TEXT,error_code TEXT,
 checked_at INTEGER NOT NULL DEFAULT 0,proof_ref TEXT
);
CREATE INDEX operations_queue ON operations(status,checked_at);
CREATE TABLE leases(name TEXT PRIMARY KEY,token TEXT,expires INTEGER NOT NULL DEFAULT 0);
INSERT INTO leases(name) VALUES ('relayer');
CREATE TABLE quotas(bucket TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
CREATE TABLE atomic_guard(ok INTEGER CHECK(ok=1));
