-- The driver's face photo belongs to the person (driver profile), never to a vehicle.
ALTER TABLE users ADD COLUMN IF NOT EXISTS driver_photo_key text;
