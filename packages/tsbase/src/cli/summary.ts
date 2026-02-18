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
  lines.push(
    `  ${GREEN}✓${RESET} ${BOLD}TSBase project "${projectName}" is running!${RESET}`,
  );
  lines.push("");
  lines.push(`  ${BOLD}Server:${RESET}     ${CYAN}${base}${RESET}`);
  lines.push(`  ${BOLD}Admin UI:${RESET}   ${CYAN}${base}/_admin${RESET}`);
  lines.push(`  ${BOLD}Health:${RESET}     ${CYAN}${base}/health${RESET}`);

  if (tables.length > 0) {
    lines.push("");
    lines.push(`  ${BOLD}CRUD Routes (auto-generated):${RESET}`);
    for (const table of tables) {
      lines.push(
        `    ${DIM}/trpc/${table}.list  /trpc/${table}.get  /trpc/${table}.create  /trpc/${table}.update  /trpc/${table}.delete${RESET}`,
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
  lines.push(`  ${BOLD}Try it:${RESET}`);
  lines.push(`    ${DIM}curl ${base}/health${RESET}`);
  lines.push(
    `    ${DIM}curl -X POST ${base}/auth/register \\${RESET}`,
  );
  lines.push(
    `    ${DIM}  -H "Content-Type: application/json" \\${RESET}`,
  );
  lines.push(
    `    ${DIM}  -d '{"email":"test@example.com","password":"password123"}'${RESET}`,
  );

  lines.push("");
  lines.push(`  Press ${BOLD}Ctrl+C${RESET} to stop the server.`);
  lines.push("");

  console.log(lines.join("\n"));
}
