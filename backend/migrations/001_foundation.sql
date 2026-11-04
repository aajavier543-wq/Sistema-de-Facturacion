CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  rif text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE tenant_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin','cashier')),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (expires_at);
CREATE TABLE login_attempts (
  key_hash text PRIMARY KEY,
  attempts integer NOT NULL,
  window_start timestamptz NOT NULL
);
CREATE TABLE branches (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,name)
);
CREATE TABLE branch_memberships (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,branch_id,user_id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY (tenant_id,user_id) REFERENCES tenant_memberships(tenant_id,user_id)
);
CREATE TABLE products (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku text NOT NULL,
  barcode text,
  name text NOT NULL,
  price_usd numeric(20,6) NOT NULL CHECK (price_usd >= 0),
  tax_category text NOT NULL CHECK (tax_category IN ('general','reduced','exempt')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,sku),
  UNIQUE (tenant_id,barcode)
);
CREATE INDEX ON products (tenant_id,lower(name));
CREATE TABLE stock_balances (
  tenant_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(20,6) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  version bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id,branch_id,product_id),
  FOREIGN KEY (tenant_id,branch_id) REFERENCES branches(tenant_id,id),
  FOREIGN KEY (tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE stock_movements (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  delta numeric(20,6) NOT NULL CHECK (delta <> 0),
  reason text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,branch_id,product_id)
    REFERENCES stock_balances(tenant_id,branch_id,product_id)
);
CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  actor_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL,
  entity_id uuid NOT NULL,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);

-- Context is set only by the trusted backend after token/membership validation.
CREATE FUNCTION app_tenant() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id',true),'')::uuid
$$;
CREATE FUNCTION app_user() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id',true),'')::uuid
$$;
CREATE FUNCTION app_branch_allowed(branch uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM tenant_memberships
    WHERE tenant_id=app_tenant() AND user_id=app_user() AND role='admin'
  ) OR EXISTS (
    SELECT 1 FROM branch_memberships
    WHERE tenant_id=app_tenant() AND user_id=app_user() AND branch_id=branch
  )
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branches','products','stock_balances','stock_movements','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_scope ON %I USING (tenant_id=app_tenant()) WITH CHECK (tenant_id=app_tenant())',t);
  END LOOP;
END $$;
CREATE POLICY branch_scope ON branches AS RESTRICTIVE
  USING (app_branch_allowed(id)) WITH CHECK (app_branch_allowed(id));
CREATE POLICY branch_scope ON stock_balances AS RESTRICTIVE
  USING (app_branch_allowed(branch_id)) WITH CHECK (app_branch_allowed(branch_id));
CREATE POLICY branch_scope ON stock_movements AS RESTRICTIVE
  USING (app_branch_allowed(branch_id)) WITH CHECK (app_branch_allowed(branch_id));

-- Runtime must never own tables or have schema CREATE privileges.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO erp_app;
GRANT SELECT ON tenants, users, tenant_memberships, branch_memberships TO erp_app;
GRANT SELECT, INSERT, DELETE ON sessions TO erp_app;
GRANT SELECT, INSERT, UPDATE ON login_attempts TO erp_app;
GRANT SELECT, INSERT ON branches, products, stock_movements, audit_events TO erp_app;
GRANT SELECT, INSERT, UPDATE ON stock_balances TO erp_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO erp_app;
