ALTER TABLE products ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0);
GRANT UPDATE ON products TO erp_app;
