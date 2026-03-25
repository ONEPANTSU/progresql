-- Create ENUM type for promo code types
CREATE TYPE promo_code_type AS ENUM ('trial_extension', 'pro_grant', 'discount');

-- Drop CHECK constraint, change column to ENUM
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_type_check;
ALTER TABLE promo_codes ALTER COLUMN type TYPE promo_code_type USING type::promo_code_type;
