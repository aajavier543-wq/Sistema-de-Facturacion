ALTER TABLE stock_balances ADD COLUMN average_cost_base numeric(30,8)
  CHECK (average_cost_base >= 0);

CREATE TABLE suppliers (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  rif text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,rif)
);
CREATE TABLE document_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('adjustment','purchase')),
  last_number bigint NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (tenant_id,kind)
);
CREATE TABLE inventory_documents (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('adjustment','purchase')),
  number bigint NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed')),
  document_date date NOT NULL,
  description text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USD','VES')),
  exchange_rate numeric(24,10) NOT NULL CHECK (exchange_rate > 0),
  supplier_id uuid,
  invoice_number text,
  control_number text,
  payment_terms text CHECK (payment_terms IN ('cash','credit')),
  due_date date,
  subtotal numeric(30,6) NOT NULL,
  discount_total numeric(30,6) NOT NULL,
  tax_total numeric(30,6) NOT NULL,
  total numeric(30,6) NOT NULL,
  inventory_value_base numeric(30,6),
  create_key uuid NOT NULL,
  create_hash text NOT NULL,
  version integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES users(id),
  confirmed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,branch_id),
  UNIQUE (tenant_id,kind,number),
  UNIQUE (tenant_id,create_key),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY (tenant_id,supplier_id) REFERENCES suppliers(tenant_id,id),
  CHECK (due_date IS NULL OR due_date >= document_date),
  CHECK ((kind='purchase' AND supplier_id IS NOT NULL AND invoice_number IS NOT NULL
    AND control_number IS NOT NULL AND payment_terms IS NOT NULL)
    OR (kind='adjustment' AND supplier_id IS NULL AND invoice_number IS NULL
    AND control_number IS NULL AND payment_terms IS NULL AND due_date IS NULL)),
  CHECK ((status='draft' AND confirmed_at IS NULL AND confirmed_by IS NULL)
    OR (status='confirmed' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_invoice_unique ON inventory_documents(tenant_id,supplier_id,invoice_number)
  WHERE kind='purchase';
CREATE INDEX inventory_documents_lookup ON inventory_documents(tenant_id,branch_id,kind,number DESC);
CREATE TABLE inventory_document_lines (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  product_id uuid NOT NULL,
  sku text NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'UNI' CHECK (unit='UNI'),
  direction text NOT NULL CHECK (direction IN ('entry','exit')),
  quantity numeric(20,6) NOT NULL CHECK (quantity > 0),
  unit_cost numeric(20,6) NOT NULL CHECK (unit_cost >= 0),
  discount_percent numeric(9,6) NOT NULL CHECK (discount_percent BETWEEN 0 AND 100),
  tax_rate numeric(9,6) NOT NULL CHECK (tax_rate IN (0,8,16)),
  gross numeric(30,6) NOT NULL,
  discount_amount numeric(30,6) NOT NULL,
  taxable_base numeric(30,6) NOT NULL,
  tax_amount numeric(30,6) NOT NULL,
  total numeric(30,6) NOT NULL,
  applied_cost_base numeric(30,8) CHECK (applied_cost_base >= 0),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,document_id,position),
  UNIQUE (tenant_id,document_id,product_id),
  UNIQUE (tenant_id,id,document_id,branch_id),
  FOREIGN KEY (tenant_id,document_id,branch_id) REFERENCES inventory_documents(tenant_id,id,branch_id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
ALTER TABLE stock_movements ADD COLUMN document_id uuid;
ALTER TABLE stock_movements ADD COLUMN document_line_id uuid;
ALTER TABLE stock_movements ADD COLUMN unit_cost_base numeric(30,8) CHECK (unit_cost_base >= 0);
ALTER TABLE stock_movements ADD CONSTRAINT movement_document_line
  FOREIGN KEY (tenant_id,document_line_id,document_id,branch_id)
  REFERENCES inventory_document_lines(tenant_id,id,document_id,branch_id);
ALTER TABLE stock_movements ADD CONSTRAINT movement_document_pair
  CHECK ((document_id IS NULL) = (document_line_id IS NULL));
CREATE UNIQUE INDEX movement_once_per_line ON stock_movements(tenant_id,document_line_id)
  WHERE document_line_id IS NOT NULL;
CREATE INDEX stock_movements_lookup ON stock_movements(tenant_id,branch_id,created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','document_counters','inventory_documents','inventory_document_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())',t);
  END LOOP;
END $$;
CREATE POLICY branch_scope ON inventory_documents AS RESTRICTIVE
  USING (app_branch_allowed(branch_id)) WITH CHECK (app_branch_allowed(branch_id));
CREATE POLICY branch_scope ON inventory_document_lines AS RESTRICTIVE
  USING (app_branch_allowed(branch_id)) WITH CHECK (app_branch_allowed(branch_id));

CREATE FUNCTION protect_inventory_document() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.status='confirmed' THEN
    RAISE EXCEPTION 'Confirmed document is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id
    OR NEW.branch_id<>OLD.branch_id OR NEW.kind<>OLD.kind OR NEW.number<>OLD.number) THEN
    RAISE EXCEPTION 'Document identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER protect_inventory_document BEFORE UPDATE OR DELETE ON inventory_documents
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_document();
CREATE FUNCTION protect_inventory_document_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d uuid; t uuid; s text;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.document_id<>OLD.document_id OR NEW.tenant_id<>OLD.tenant_id
    OR NEW.branch_id<>OLD.branch_id OR NEW.id<>OLD.id) THEN
    RAISE EXCEPTION 'Line identity is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN d:=OLD.document_id; t:=OLD.tenant_id;
    ELSE d:=NEW.document_id; t:=NEW.tenant_id; END IF;
  SELECT status INTO s FROM inventory_documents WHERE tenant_id=t AND id=d FOR UPDATE;
  IF s IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'Only draft lines can be changed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER protect_inventory_document_line BEFORE INSERT OR UPDATE OR DELETE ON inventory_document_lines
  FOR EACH ROW EXECUTE FUNCTION protect_inventory_document_line();

GRANT SELECT,INSERT ON suppliers TO erp_app;
GRANT SELECT,INSERT,UPDATE ON document_counters,inventory_documents TO erp_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON inventory_document_lines TO erp_app;
