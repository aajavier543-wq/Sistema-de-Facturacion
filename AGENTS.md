# Workflow for this application

- Use the existing checkout. Do not create a worktree unless the user requests one.
- The user explicitly authorized publishing and deploying each application update they request.
  This replaces their earlier instruction to keep changes local. Do not ask again for approval
  to publish/deploy requested updates, including the automatic deployment setting on `main`.
- Target only `aajavier543-wq/Sistema-de-Facturacion`, branch `main`, and the Render web service
  `nexo-facturacion-demo` (`srv-dblq30gn74is73cci9pg`). The existing PostgreSQL instance is
  `farma-educa-db`; this application uses the separate logical database `nexo_facturacion`.
- Preserve unrelated services and existing data. Do not switch to paid plans without authorization.
- Validate the affected workflow before pushing. Backend: `npm test` in `backend`.
  Browser workflows: `npm run test:browser` in `backend`; see README for PostgreSQL/Chromium setup.
- Publish source, then deploy the exact commit or verify Render's automatic deployment.
  A successful push is not a successful deployment. Check remote status and application behavior.
- Use configured authentication normally. Never print secrets, database URLs, tokens or admin.json.
  If an API operation is rejected, report its actual status and the precise missing prerequisite.
- Configuration drafts do not execute commands, change live Render settings or deploy the app.
