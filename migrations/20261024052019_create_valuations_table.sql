/*
# Create valuations table (single-tenant, no auth)

## Purpose
Stores a history of second-hand item valuations created by the user. Each row
holds the item details the user entered (category, brand, condition, estimated
value, asking price, and verdict) plus a small reference thumbnail of the item
photo stored as a base64 data URL.

This is a single-tenant app with no sign-in screen, so the anon-key frontend
reads and writes as the `anon` role. All policies target `anon, authenticated`
and allow all rows (intentionally shared/public).

## New Tables
- `valuations`
  - `id` (uuid, primary key)
  - `image_data_url` (text, optional base64 thumbnail of the scanned item)
  - `item_name` (text, name the user gave the item)
  - `category` (text, e.g. Electronics, Clothing)
  - `brand` (text, brand or maker)
  - `model` (text, optional model/variant)
  - `condition` (text, one of: new, like-new, good, fair, poor)
  - `estimated_value_low` (numeric, lower bound of the estimate)
  - `estimated_value_mid` (numeric, central estimate)
  - `estimated_value_high` (numeric, upper bound of the estimate)
  - `asking_price` (numeric, optional price the seller is asking)
  - `verdict` (text, optional: great-deal, fair, overpriced, likely-scam)
  - `notes` (text, optional user notes)
  - `created_at` (timestamptz, default now())

## Security
- RLS enabled on `valuations`.
- CRUD granted to `anon, authenticated` so the Data API can reach the table.
- Four per-verb policies allowing all rows (intentionally public, single-tenant).
*/

CREATE TABLE IF NOT EXISTS valuations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_data_url text,
  item_name text NOT NULL,
  category text NOT NULL,
  brand text NOT NULL DEFAULT 'Unknown',
  model text,
  condition text NOT NULL DEFAULT 'good',
  estimated_value_low numeric(10,2) NOT NULL DEFAULT 0,
  estimated_value_mid numeric(10,2) NOT NULL DEFAULT 0,
  estimated_value_high numeric(10,2) NOT NULL DEFAULT 0,
  asking_price numeric(10,2),
  verdict text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE valuations ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON valuations TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_valuations" ON valuations;
CREATE POLICY "anon_select_valuations" ON valuations FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_valuations" ON valuations;
CREATE POLICY "anon_insert_valuations" ON valuations FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_valuations" ON valuations;
CREATE POLICY "anon_update_valuations" ON valuations FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_valuations" ON valuations;
CREATE POLICY "anon_delete_valuations" ON valuations FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS valuations_created_at_idx ON valuations (created_at DESC);
