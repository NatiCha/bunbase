import type { OAuthProvider } from "./templates.ts";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function printSummary({
  projectName,
  tables,
  oauth,
  port,
}: {
  projectName: string;
  tables: string[];
  oauth: OAuthProvider[];
  port: number;
}) {
  const base = `http://localhost:${port}`;
  const lines: string[] = [];

  lines.push("");
  lines.push(`  ${GREEN}✓${RESET} ${BOLD}BunBase project "${projectName}" is running!${RESET}`);
  lines.push("");
  lines.push(`  ${BOLD}Server:${RESET}     ${CYAN}${base}${RESET}`);
  lines.push(`  ${BOLD}Admin UI:${RESET}   ${CYAN}${base}/_admin${RESET}`);
  lines.push(`  ${BOLD}Health:${RESET}     ${CYAN}${base}/health${RESET}`);

  if (tables.length > 0) {
    lines.push("");
    lines.push(`  ${BOLD}CRUD Routes (auto-generated):${RESET}`);
    for (const table of tables) {
      lines.push(
        `    ${DIM}GET /api/${table}  POST /api/${table}  GET /api/${table}/:id  PATCH /api/${table}/:id  DELETE /api/${table}/:id${RESET}`,
      );
    }
  }

  lines.push("");
  lines.push(
    `  ${BOLD}Auth:${RESET}       POST /auth/register  POST /auth/login  POST /auth/logout`,
  );

  if (oauth.length > 0) {
    const oauthRoutes = oauth
      .map((p) => `GET /auth/oauth/${p}`)
      .join("  ");
    lines.push(`  ${BOLD}OAuth:${RESET}      ${oauthRoutes}`);
  }

  lines.push("");
  lines.push(`  ${BOLD}Admin login (development):${RESET}`);
  lines.push(`    Email:    ${BOLD}admin@example.com${RESET}`);
  lines.push(`    Password: ${BOLD}admin${RESET}`);
  lines.push(`    ${DIM}(change this after first login)${RESET}`);
  lines.push(`    ${DIM}In production, set BUNBASE_ADMIN_EMAIL and BUNBASE_ADMIN_PASSWORD env vars.${RESET}`);

  lines.push("");
  lines.push(`  ${BOLD}Try it:${RESET}`);
  lines.push(`    ${DIM}curl ${base}/health${RESET}`);
  lines.push(`    ${DIM}curl -X POST ${base}/auth/register \\${RESET}`);
  lines.push(`    ${DIM}  -H "Content-Type: application/json" \\${RESET}`);
  lines.push(`    ${DIM}  -d '{"email":"test@example.com","password":"password123"}'${RESET}`);


  lines.push("");

  console.log(lines.join("\n"));
}
