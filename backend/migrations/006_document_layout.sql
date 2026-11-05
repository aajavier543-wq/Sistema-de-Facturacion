ALTER TABLE inventory_documents ADD COLUMN purchase_document_type text NOT NULL DEFAULT 'invoice'
  CHECK (purchase_document_type IN ('invoice','delivery_note'));
-- Replace only the old purchase-header check; identities, RLS and confirmed-document guards remain.
DO $$ DECLARE c record; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='inventory_documents'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%supplier_id IS NOT NULL%'
    AND pg_get_constraintdef(oid) LIKE '%control_number IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE inventory_documents DROP CONSTRAINT %I',c.conname); END LOOP;
END $$;
ALTER TABLE inventory_documents ADD CONSTRAINT purchase_document_header CHECK (
 (kind='purchase' AND supplier_id IS NOT NULL AND invoice_number IS NOT NULL AND payment_terms IS NOT NULL
   AND ((purchase_document_type='invoice' AND control_number IS NOT NULL)
     OR (purchase_document_type='delivery_note' AND control_number IS NULL)))
 OR (kind='adjustment' AND purchase_document_type='invoice' AND supplier_id IS NULL AND invoice_number IS NULL
   AND control_number IS NULL AND payment_terms IS NULL AND due_date IS NULL)
);
DROP INDEX purchase_invoice_unique;
CREATE UNIQUE INDEX purchase_invoice_unique ON inventory_documents(tenant_id,supplier_id,purchase_document_type,invoice_number)
 WHERE kind='purchase';
