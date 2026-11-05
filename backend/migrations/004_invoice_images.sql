ALTER TABLE products ADD COLUMN price_pending boolean NOT NULL DEFAULT false;
ALTER TABLE products ADD COLUMN catalog_source_key text;
CREATE UNIQUE INDEX product_catalog_source ON products(tenant_id,catalog_source_key)
  WHERE catalog_source_key IS NOT NULL;
ALTER TABLE inventory_documents ADD COLUMN source_kind text NOT NULL DEFAULT 'manual'
  CHECK (source_kind IN ('manual','image','example'));
ALTER TABLE inventory_documents ADD COLUMN source_image_hash text
  CHECK (source_image_hash IS NULL OR source_image_hash ~ '^[a-f0-9]{64}$');
ALTER TABLE inventory_documents ADD COLUMN source_ocr_text text
  CHECK (source_ocr_text IS NULL OR length(source_ocr_text)<=50000);
CREATE UNIQUE INDEX invoice_image_once ON inventory_documents(tenant_id,source_image_hash)
  WHERE source_image_hash IS NOT NULL;
