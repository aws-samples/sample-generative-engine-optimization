-- Octank Hotels — sample seed data (placeholder)
-- Applied after schema.sql. Replace with the real sample dataset.

INSERT INTO properties (name, city, country, description, amenities)
VALUES
    ('Octank Demo Hotel', 'Seattle', 'USA', 'Placeholder demo property.',
     '["wifi","pool","parking"]'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO room_types (property_id, name, capacity)
VALUES
    (1, 'Standard King', 2),
    (1, 'Deluxe Suite', 4)
ON CONFLICT DO NOTHING;
