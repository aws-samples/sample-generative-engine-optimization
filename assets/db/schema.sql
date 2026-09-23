-- Octank Hotels — schema DDL (placeholder)
-- Aurora PostgreSQL. Applied by a schema-loader (built with ComputeStack).
-- Replace with the real hotel booking schema.

CREATE TABLE IF NOT EXISTS properties (
    property_id   SERIAL PRIMARY KEY,
    name          TEXT NOT NULL,
    city          TEXT NOT NULL,
    country       TEXT NOT NULL,
    description   TEXT,
    amenities     JSONB DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS room_types (
    room_type_id  SERIAL PRIMARY KEY,
    property_id   INTEGER NOT NULL REFERENCES properties(property_id),
    name          TEXT NOT NULL,
    capacity      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rates (
    rate_id       SERIAL PRIMARY KEY,
    room_type_id  INTEGER NOT NULL REFERENCES room_types(room_type_id),
    date          DATE NOT NULL,
    price_cents   INTEGER NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'USD'
);

CREATE TABLE IF NOT EXISTS availability (
    availability_id SERIAL PRIMARY KEY,
    room_type_id    INTEGER NOT NULL REFERENCES room_types(room_type_id),
    date            DATE NOT NULL,
    rooms_available INTEGER NOT NULL
);
