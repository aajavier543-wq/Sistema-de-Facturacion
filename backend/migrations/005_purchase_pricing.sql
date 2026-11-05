-- Existing documents retain their original confirmation behavior; new purchases require pricing.
ALTER TABLE products ADD COLUMN profit_percent numeric(9,4)
  CHECK (profit_percent BETWEEN 0 AND 1000);
ALTER TABLE inventory_documents ADD COLUMN pricing_required boolean NOT NULL DEFAULT false;
ALTER TABLE inventory_documents ADD COLUMN pricing_rate numeric(24,10) CHECK (pricing_rate>0);
ALTER TABLE inventory_documents ADD COLUMN pricing_key uuid;
ALTER TABLE inventory_documents ADD COLUMN pricing_hash text;
ALTER TABLE inventory_documents ADD CONSTRAINT purchase_pricing_only
  CHECK (kind='purchase' OR (NOT pricing_required AND pricing_rate IS NULL AND pricing_key IS NULL AND pricing_hash IS NULL));
ALTER TABLE inventory_document_lines ADD COLUMN profit_percent numeric(9,4)
  CHECK (profit_percent BETWEEN 0 AND 1000);
ALTER TABLE inventory_document_lines ADD COLUMN sale_price_usd numeric(20,6) CHECK (sale_price_usd>=0);
ALTER TABLE inventory_document_lines ADD COLUMN pricing_product_version integer CHECK (pricing_product_version>=0);
