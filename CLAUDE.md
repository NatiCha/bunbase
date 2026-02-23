
## BunBase — Project Conventions

### Architecture
- Monorepo: `packages/bunbase/` is the library, `examples/task-manager/` is the demo app
- Entry point: `packages/bunbase/src/index.ts` — exports `createServer`, `defineConfig`, `defineRules`, `defineHooks`
- Testing utilities: `packages/bunbase/src/testing/index.ts` — exported from `bunbase/testing` subpath

### Key APIs

**Rules** — deny by default; always define rules for every operation you want to expose:
```ts
import { defineRules, allowAll } from "bunbase";

// Typed overload (preferred) — record/body inferred from Drizzle table:
rules: {
  posts: defineRules(schema.posts, {
    list: () => true,
    get: () => true,
    create: ({ auth }) => auth !== null,
    update: ({ record, auth }) => record.authorId === auth?.id,
    delete: ({ auth }) => auth?.role === "admin",
  }),
}
// Multi-table shorthand (untyped):
rules: defineRules({ posts: { list: () => true } })
```

**Hooks** — typed overload infers record/data from Drizzle table:
```ts
import { defineHooks } from "bunbase";

hooks: {
  posts: defineHooks(schema.posts, {
    beforeCreate: ({ data, auth, request }) => ({ ...data, authorId: auth?.id }),
    afterCreate: ({ record, request }) => { /* record is typed as Post */ },
  }),
}
```
All hook contexts include `request: { method, path, ip, headers }`.

**AuthUser** — no index signature; extend via declaration merging:
```ts
declare module "bunbase" {
  interface AuthUser { organizationId: string; plan: "free" | "pro"; }
}
```

### Testing
Prefer `createTestServer` over manual server setup — auto-creates tables, handles CSRF, starts on port 0:
```ts
import { createTestServer } from "bunbase/testing";

const server = await createTestServer({ schema: { posts }, rules: { ... } });
afterAll(() => server.cleanup());

test("creates post", async () => {
  const res = await server.fetch("/api/posts", { method: "POST", body: JSON.stringify({ ... }) });
  expect(res.status).toBe(201);
});
```
Use `server.adapter.rawExecute(sql)` to seed data directly.

### CLI
- `bunbase init [name]` — interactive project scaffolder
- `bun create bunbase [name]` — same thing, zero-install via `create-bunbase` bin entry

### Package exports
- `bunbase` — main API (`createServer`, `defineRules`, `defineHooks`, helpers)
- `bunbase/client` — frontend SDK (`createBunBaseClient`)
- `bunbase/react` — React hooks (`createBunBaseReact`)
- `bunbase/testing` — test utilities (`createTestServer`)

### BunBase Docs Index

IMPORTANT: Before implementing or modifying a BunBase feature, read the relevant doc file.

```
[BunBase Docs]|root: ./packages/bunbase/docs
|:{index.md,quickstart.md,schema.md,rules.md,hooks.md,client.md,configuration.md,deployment.md,extending.md,jobs.md,realtime.md,testing.md}
|api:{auth.md,crud.md,files.md,api-keys.md}
```

---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres and MySQL. Don't use `pg`, `postgres.js`, or `mysql2`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

<!-- bun-docs-index:start -->

## Bun Docs Index

IMPORTANT: Before writing code that uses Bun APIs, read the relevant .mdx file. Do not rely on pre-trained knowledge for Bun APIs.

```
[Bun Docs]|root: ./packages/bunbase/node_modules/bun-types/docs
|:{feedback.mdx,index.mdx,installation.mdx,quickstart.mdx,typescript.mdx}
|bundler:{bytecode.mdx,css.mdx,esbuild.mdx,executables.mdx,fullstack.mdx,hot-reloading.mdx,html-static.mdx,index.mdx,loaders.mdx,macros.mdx,minifier.mdx,plugins.mdx}
|guides:{index.mdx}
|guides/binary:{arraybuffer-to-array.mdx,arraybuffer-to-blob.mdx,arraybuffer-to-buffer.mdx,arraybuffer-to-string.mdx,arraybuffer-to-typedarray.mdx,blob-to-arraybuffer.mdx,blob-to-dataview.mdx,blob-to-stream.mdx,blob-to-string.mdx,blob-to-typedarray.mdx,buffer-to-arraybuffer.mdx,buffer-to-blob.mdx,buffer-to-readablestream.mdx,buffer-to-string.mdx,buffer-to-typedarray.mdx,dataview-to-string.mdx,typedarray-to-arraybuffer.mdx,typedarray-to-blob.mdx,typedarray-to-buffer.mdx,typedarray-to-dataview.mdx,typedarray-to-readablestream.mdx,typedarray-to-string.mdx}
|guides/deployment:{aws-lambda.mdx,digital-ocean.mdx,google-cloud-run.mdx,railway.mdx,render.mdx,vercel.mdx}
|guides/ecosystem:{astro.mdx,discordjs.mdx,docker.mdx,drizzle.mdx,elysia.mdx,express.mdx,gel.mdx,hono.mdx,mongoose.mdx,neon-drizzle.mdx,neon-serverless-postgres.mdx,nextjs.mdx,nuxt.mdx,pm2.mdx,prisma-postgres.mdx,prisma.mdx,qwik.mdx,react.mdx,remix.mdx,sentry.mdx,solidstart.mdx,ssr-react.mdx,stric.mdx,sveltekit.mdx,systemd.mdx,tanstack-start.mdx,upstash.mdx,vite.mdx}
|guides/html-rewriter:{extract-links.mdx,extract-social-meta.mdx}
|guides/http:{cluster.mdx,fetch-unix.mdx,fetch.mdx,file-uploads.mdx,hot.mdx,proxy.mdx,server.mdx,simple.mdx,stream-file.mdx,stream-iterator.mdx,stream-node-streams-in-bun.mdx,tls.mdx}
|guides/install:{add-dev.mdx,add-git.mdx,add-optional.mdx,add-peer.mdx,add-tarball.mdx,add.mdx,azure-artifacts.mdx,cicd.mdx,custom-registry.mdx,from-npm-install-to-bun-install.mdx,git-diff-bun-lockfile.mdx,jfrog-artifactory.mdx,npm-alias.mdx,registry-scope.mdx,trusted.mdx,workspaces.mdx,yarnlock.mdx}
|guides/process:{argv.mdx,ctrl-c.mdx,ipc.mdx,nanoseconds.mdx,os-signals.mdx,spawn-stderr.mdx,spawn-stdout.mdx,spawn.mdx,stdin.mdx}
|guides/read-file:{arraybuffer.mdx,buffer.mdx,exists.mdx,json.mdx,mime.mdx,stream.mdx,string.mdx,uint8array.mdx,watch.mdx}
|guides/runtime:{build-time-constants.mdx,cicd.mdx,codesign-macos-executable.mdx,define-constant.mdx,delete-directory.mdx,delete-file.mdx,heap-snapshot.mdx,import-html.mdx,import-json.mdx,import-json5.mdx,import-toml.mdx,import-yaml.mdx,read-env.mdx,set-env.mdx,shell.mdx,timezone.mdx,tsconfig-paths.mdx,typescript.mdx,vscode-debugger.mdx,web-debugger.mdx}
|guides/streams:{node-readable-to-arraybuffer.mdx,node-readable-to-blob.mdx,node-readable-to-json.mdx,node-readable-to-string.mdx,node-readable-to-uint8array.mdx,to-array.mdx,to-arraybuffer.mdx,to-blob.mdx,to-buffer.mdx,to-json.mdx,to-string.mdx,to-typedarray.mdx}
|guides/test:{bail.mdx,concurrent-test-glob.mdx,coverage-threshold.mdx,coverage.mdx,happy-dom.mdx,migrate-from-jest.mdx,mock-clock.mdx,mock-functions.mdx,rerun-each.mdx,run-tests.mdx,skip-tests.mdx,snapshot.mdx,spy-on.mdx,svelte-test.mdx,testing-library.mdx,timeout.mdx,todo-tests.mdx,update-snapshots.mdx,watch-mode.mdx}
|guides/util:{base64.mdx,deep-equals.mdx,deflate.mdx,detect-bun.mdx,entrypoint.mdx,escape-html.mdx,file-url-to-path.mdx,gzip.mdx,hash-a-password.mdx,import-meta-dir.mdx,import-meta-file.mdx,import-meta-path.mdx,javascript-uuid.mdx,main.mdx,path-to-file-url.mdx,sleep.mdx,upgrade.mdx,version.mdx,which-path-to-executable-bin.mdx}
|guides/websocket:{compression.mdx,context.mdx,pubsub.mdx,simple.mdx}
|guides/write-file:{append.mdx,basic.mdx,blob.mdx,cat.mdx,file-cp.mdx,filesink.mdx,response.mdx,stdout.mdx,stream.mdx,unlink.mdx}
|pm:{bunx.mdx,catalogs.mdx,filter.mdx,global-cache.mdx,isolated-installs.mdx,lifecycle.mdx,lockfile.mdx,npmrc.mdx,overrides.mdx,scopes-registries.mdx,security-scanner-api.mdx,workspaces.mdx}
|pm/cli:{add.mdx,audit.mdx,info.mdx,install.mdx,link.mdx,outdated.mdx,patch.mdx,pm.mdx,publish.mdx,remove.mdx,update.mdx,why.mdx}
|project:{benchmarking.mdx,bindgen.mdx,building-windows.mdx,contributing.mdx,feedback.mdx,license.mdx,roadmap.mdx}
|runtime:{archive.mdx,auto-install.mdx,binary-data.mdx,bun-apis.mdx,bunfig.mdx,c-compiler.mdx,child-process.mdx,color.mdx,console.mdx,cookies.mdx,debugger.mdx,environment-variables.mdx,ffi.mdx,file-io.mdx,file-system-router.mdx,file-types.mdx,glob.mdx,globals.mdx,hashing.mdx,html-rewriter.mdx,index.mdx,json5.mdx,jsonl.mdx,jsx.mdx,markdown.mdx,module-resolution.mdx,node-api.mdx,nodejs-compat.mdx,plugins.mdx,redis.mdx,s3.mdx,secrets.mdx,semver.mdx,shell.mdx,sql.mdx,sqlite.mdx,streams.mdx,transpiler.mdx,typescript.mdx,utils.mdx,watch-mode.mdx,web-apis.mdx,workers.mdx,yaml.mdx}
|runtime/http:{cookies.mdx,error-handling.mdx,metrics.mdx,routing.mdx,server.mdx,tls.mdx,websockets.mdx}
|runtime/networking:{dns.mdx,fetch.mdx,tcp.mdx,udp.mdx}
|runtime/templating:{create.mdx,init.mdx}
|snippets/cli:{add.mdx,build.mdx,bunx.mdx,feedback.mdx,init.mdx,install.mdx,link.mdx,outdated.mdx,patch.mdx,publish.mdx,remove.mdx,run.mdx,test.mdx,update.mdx}
|test:{code-coverage.mdx,configuration.mdx,dates-times.mdx,discovery.mdx,dom.mdx,index.mdx,lifecycle.mdx,mocks.mdx,reporters.mdx,runtime-behavior.mdx,snapshots.mdx,writing-tests.mdx}
```

<!-- bun-docs-index:end -->

<!-- ccc:start -->
## Project Context — bunbase

Client: personal
Project Hub: /Users/charlessqueri/Library/Mobile Documents/iCloud~md~obsidian/Documents/work/clients/personal/projects/bunbase

This project is managed through the Claude Command Center (CCC). The project hub above is a directory of markdown files containing tasks, status, decisions, PRDs, and session logs. You can read these files directly — they are organized for self-discovery:

```
/Users/charlessqueri/Library/Mobile Documents/iCloud~md~obsidian/Documents/work/clients/personal/projects/bunbase/
├── PROJECT.md        # Project overview and metadata
├── TASKS.md          # Task list with checkbox statuses
├── STATUS.md         # Current project status
├── DECISIONS.md      # Decision log
├── prds/             # Product requirement documents
├── sessions/         # Timestamped session logs
└── comms/            # Client communications
```

Task statuses in TASKS.md: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked.

### CCC CLI
Use the `ccc` CLI for structured operations (creating, updating, scaffolding). Read files directly for exploration.

- List tasks: `ccc task list personal bunbase`
- Project status: `ccc status personal bunbase`
- Update a task: `ccc task update personal bunbase <line> <status>`  (statuses: todo, in_progress, done, blocked)
- Add a task: `ccc task add personal bunbase "<text>"`
- Log a session: `ccc session create personal bunbase "<description>"`
<!-- ccc:end -->
