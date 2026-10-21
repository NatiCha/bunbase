import app from "./templates/team-workspace/app.ts.txt" with { type: "text" };
import compose from "./templates/team-workspace/compose.yaml.txt" with { type: "text" };
import dockerfile from "./templates/team-workspace/Dockerfile.txt" with { type: "text" };
import html from "./templates/team-workspace/index.html.txt" with { type: "text" };
import sampleTest from "./templates/team-workspace/index.test.ts.txt" with { type: "text" };
import indexTs from "./templates/team-workspace/index.ts.txt" with { type: "text" };
import readme from "./templates/team-workspace/README.md.txt" with { type: "text" };
import routes from "./templates/team-workspace/routes.ts.txt" with { type: "text" };
import rules from "./templates/team-workspace/rules.ts.txt" with { type: "text" };
import schema from "./templates/team-workspace/schema.ts.txt" with { type: "text" };
import css from "./templates/team-workspace/style.css.txt" with { type: "text" };

export const teamWorkspace = {
  schema,
  rules,
  indexTs,
  sampleTest,
  tables: ["requests"],
  description: "Team workspace with private requests, invitations, attachments, and approvals",
  files: {
    "src/routes.ts": routes,
    "src/portal/index.html": html,
    "src/portal/app.ts": app,
    "src/portal/style.css": css,
    Dockerfile: dockerfile,
    "compose.yaml": compose,
    Caddyfile: "{$APP_DOMAIN} {\n  reverse_proxy app:3000\n}\n",
    ".dockerignore": "node_modules\ndata\nbackups\nrestored\n.git\n.env*\n.bunbase-service-key\n",
    "README.md": readme,
    ".gitignore":
      "node_modules\ndist\ndata/\nbackups/\nrestored/\n.env\n.env.*\n!.env.example\n.bunbase-service-key\n*.tsbuildinfo\n.DS_Store\n",
    ".env.example":
      "# Local development uses bun dev. For production, set these values:\nAPP_DOMAIN=workspace.example.com\nPUBLIC_URL=https://workspace.example.com\nBUNBASE_ADMIN_EMAIL=\nBUNBASE_ADMIN_PASSWORD=\nBUNBASE_SERVICE_KEY=\n",
  },
};
