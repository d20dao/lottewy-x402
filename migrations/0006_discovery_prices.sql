-- One shared discovery estimate per execution configuration, across isolates.
CREATE TABLE discovery_prices (
  profile TEXT PRIMARY KEY,
  amount TEXT NOT NULL,
  expires INTEGER NOT NULL
);
