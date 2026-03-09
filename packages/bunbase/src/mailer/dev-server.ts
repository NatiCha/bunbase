/**
 * BunBase dev mail server — zero-Docker local SMTP catch-all + web UI.
 *
 * Starts a local SMTP receiver (Bun.listen TCP) and a simple web UI (Bun.serve HTTP).
 * Captures all outgoing emails in memory so you can inspect them in the browser.
 *
 * @example
 * ```ts
 * import { createDevMailServer } from "bunbase";
 *
 * // In your dev server setup:
 * const devMail = createDevMailServer();
 * console.log(`Dev mail UI: ${devMail.url}`);
 * ```
 * @module
 */

/**
 * A received email captured by the dev mail server.
 */
export interface ReceivedEmail {
  /** Unique ID (random UUID) */
  id: string;
  /** MAIL FROM envelope address */
  from: string;
  /** RCPT TO envelope address */
  to: string;
  /** Parsed subject header */
  subject: string;
  /** Parsed HTML body */
  html: string;
  /** Parsed plain-text body, if present */
  text?: string;
  /** ISO timestamp when the email was received */
  receivedAt: string;
}

/**
 * Configuration for `createDevMailServer`.
 */
export interface DevMailServerConfig {
  /** TCP port for the SMTP receiver. Default: `1025` */
  smtpPort?: number;
  /** HTTP port for the web UI. Default: `1026` */
  httpPort?: number;
  /** Hostname to bind to. Default: `"localhost"` */
  hostname?: string;
}

/**
 * A running dev mail server instance returned by `createDevMailServer`.
 */
export interface DevMailServer {
  /** The underlying Bun TCP listener (SMTP). */
  smtp: { stop(closeActiveConnections?: boolean): void; ref(): void; unref(): void };
  /** The underlying Bun HTTP server (web UI). */
  http: { stop(closeActiveConnections?: boolean): void; url: URL };
  /** In-memory array of received emails. Inspect in tests or code. */
  emails: ReceivedEmail[];
  /** Web UI URL, e.g. `"http://localhost:1026"` */
  url: string;
  /** Stop both the SMTP and HTTP servers. */
  stop(): void;
}

// ---------------------------------------------------------------------------
// SMTP receiver state per connection
// ---------------------------------------------------------------------------

type SmtpReceiverState =
  | "ready" // waiting for EHLO/HELO
  | "after-ehlo" // got EHLO, waiting for MAIL FROM
  | "after-mail-from" // got MAIL FROM, waiting for RCPT TO
  | "after-rcpt-to" // got RCPT TO, waiting for DATA
  | "collecting-data" // inside DATA block
  | "done"; // QUIT received

interface SmtpConnection {
  state: SmtpReceiverState;
  mailFrom: string;
  rcptTo: string;
  dataLines: string[];
  lineBuffer: string;
}

// ---------------------------------------------------------------------------
// Email body parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw email body (as transmitted in the SMTP DATA phase) into
 * structured fields. Best-effort; handles the format produced by our
 * own createSmtpTransport (base64 multipart/alternative and single HTML part).
 */
function parseEmailBody(raw: string): {
  subject: string;
  html: string;
  text?: string;
} {
  // Separate headers from body
  const sepIdx = raw.indexOf("\r\n\r\n");
  if (sepIdx === -1) {
    return { subject: "(no subject)", html: raw };
  }

  const headerBlock = raw.slice(0, sepIdx);
  const body = raw.slice(sepIdx + 4);

  // Parse headers (handles multi-line folding)
  const headers: Record<string, string> = {};
  let currentKey = "";
  for (const line of headerBlock.split("\r\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && currentKey) {
      headers[currentKey] = `${headers[currentKey] ?? ""} ${line.trim()}`;
    } else {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        currentKey = line.slice(0, colonIdx).toLowerCase().trim();
        headers[currentKey] = line.slice(colonIdx + 1).trim();
      }
    }
  }

  const subject = headers.subject ?? "(no subject)";
  const contentType = headers["content-type"] ?? "text/html";
  const transferEncoding = (headers["content-transfer-encoding"] ?? "").toLowerCase();

  /** Decode a MIME part body given its content-transfer-encoding */
  function decode(content: string, encoding: string): string {
    if (encoding === "base64") {
      return Buffer.from(content.replace(/[\r\n]/g, ""), "base64").toString("utf8");
    }
    return content;
  }

  // Multipart/alternative — produced by our smtp.ts transport
  if (contentType.toLowerCase().includes("multipart")) {
    const boundaryMatch = contentType.match(/boundary="?([^";,\s]+)"?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = body.split(`--${boundary}`);
      let html = "";
      let text: string | undefined;

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed || trimmed === "--") continue;

        const partSepIdx = trimmed.indexOf("\r\n\r\n");
        if (partSepIdx === -1) continue;

        const partHeaderBlock = trimmed.slice(0, partSepIdx).toLowerCase();
        const partBody = trimmed.slice(partSepIdx + 4);
        const partEncoding = partHeaderBlock.includes("base64") ? "base64" : "8bit";

        if (partHeaderBlock.includes("text/html")) {
          html = decode(partBody, partEncoding);
        } else if (partHeaderBlock.includes("text/plain")) {
          text = decode(partBody, partEncoding);
        }
      }

      return { subject, html: html || "(no HTML body)", text };
    }
  }

  // Single part
  const decoded = decode(body.trim(), transferEncoding);
  if (contentType.toLowerCase().includes("text/plain")) {
    return {
      subject,
      html: `<pre style="white-space:pre-wrap;font-family:monospace">${decoded}</pre>`,
      text: decoded,
    };
  }

  return { subject, html: decoded };
}

// ---------------------------------------------------------------------------
// Web UI HTML
// ---------------------------------------------------------------------------

function buildWebUiHtml(httpPort: number): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BunBase Dev Mail</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;display:flex;height:100vh;overflow:hidden;background:#fafafa;color:#111}
#sidebar{width:300px;min-width:220px;border-right:1px solid #e5e7eb;display:flex;flex-direction:column;background:#fff}
#header{padding:14px 16px;border-bottom:1px solid #e5e7eb}
#header h1{font-size:14px;font-weight:600;color:#111}
#header p{font-size:12px;color:#6b7280;margin-top:2px}
#clear-btn{margin-top:8px;font-size:11px;color:#ef4444;background:none;border:none;cursor:pointer;padding:0;text-align:left}
#clear-btn:hover{text-decoration:underline}
#email-list{flex:1;overflow-y:auto}
.email-item{padding:10px 14px;border-bottom:1px solid #f3f4f6;cursor:pointer;transition:background 0.1s}
.email-item:hover{background:#f9fafb}
.email-item.active{background:#eff6ff;border-left:2px solid #3b82f6}
.email-item .to{font-size:12px;font-weight:500;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.email-item .subj{font-size:11px;color:#374151;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.email-item .meta{font-size:10px;color:#9ca3af;margin-top:2px}
#preview{flex:1;display:flex;flex-direction:column;min-width:0}
#preview-header{padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#fff;flex-shrink:0}
#preview-header .label{font-size:10px;text-transform:uppercase;letter-spacing:0.05em;color:#9ca3af}
#preview-header .value{font-size:13px;color:#374151;margin-top:2px;word-break:break-all}
#preview-header .subject{font-size:15px;font-weight:600;color:#111;margin-top:4px}
#preview-body{flex:1;overflow:auto;background:#fff}
#empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:#9ca3af}
#empty svg{opacity:0.3}
#empty p{font-size:13px}
#badge{display:inline-flex;align-items:center;justify-content:center;background:#3b82f6;color:#fff;font-size:10px;font-weight:600;border-radius:999px;min-width:18px;height:18px;padding:0 5px;margin-left:6px;vertical-align:middle}
</style>
</head>
<body>
<div id="sidebar">
  <div id="header">
    <h1>BunBase Dev Mail <span id="badge" style="display:none">0</span></h1>
    <p id="smtp-info">SMTP :${httpPort - 1} · UI :${httpPort}</p>
    <button id="clear-btn" onclick="clearEmails()">Clear all</button>
  </div>
  <div id="email-list"></div>
</div>
<div id="preview">
  <div id="empty">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
    <p>No email selected</p>
    <p style="font-size:11px">Emails sent to SMTP port ${httpPort - 1} will appear here</p>
  </div>
</div>
<script>
var emails = [];
var selectedId = null;

function fmt(iso) {
  var d = new Date(iso);
  return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderList() {
  var list = document.getElementById('email-list');
  var badge = document.getElementById('badge');
  if (emails.length === 0) {
    badge.style.display = 'none';
    list.innerHTML = '<div style="padding:20px 14px;font-size:12px;color:#9ca3af">No emails yet.</div>';
    return;
  }
  badge.style.display = 'inline-flex';
  badge.textContent = emails.length;
  list.innerHTML = emails.slice().reverse().map(function(e) {
    return '<div class="email-item' + (e.id === selectedId ? ' active' : '') + '" onclick="selectEmail(\\''+e.id+'\\')">'+
      '<div class="to">' + esc(e.to) + '</div>'+
      '<div class="subj">' + esc(e.subject) + '</div>'+
      '<div class="meta">' + fmt(e.receivedAt) + ' &middot; from ' + esc(e.from) + '</div>'+
    '</div>';
  }).join('');
}

function selectEmail(id) {
  selectedId = id;
  var email = emails.find(function(e){ return e.id === id; });
  if (!email) return;
  renderList();
  var preview = document.getElementById('preview');
  preview.innerHTML =
    '<div id="preview-header">'+
      '<div class="label">To</div><div class="value">' + esc(email.to) + '</div>'+
      '<div class="label" style="margin-top:6px">From</div><div class="value">' + esc(email.from) + '</div>'+
      '<div class="subject">' + esc(email.subject) + '</div>'+
      '<a href="/api/emails/' + esc(email.id) + '/html" target="_blank" style="display:inline-block;margin-top:8px;font-size:11px;color:#6b7280;text-decoration:underline">Open in new tab</a>'+
    '</div>'+
    '<div id="preview-body"></div>';
  // Render email HTML inside a Shadow DOM for style isolation (no iframe needed).
  fetch('/api/emails/' + id + '/html')
    .then(function(r){ return r.text(); })
    .then(function(html){
      var container = document.getElementById('preview-body');
      if (!container) return;
      var shadow = container.attachShadow({ mode: 'open' });
      shadow.innerHTML = html;
      // Make links open in a new tab instead of navigating the dev UI
      shadow.querySelectorAll('a[href]').forEach(function(a){
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
      });
    });
}

async function fetchEmails() {
  try {
    var res = await fetch('/api/emails');
    var data = await res.json();
    if (data.length !== emails.length) {
      var wasEmpty = emails.length === 0;
      emails = data;
      renderList();
      if (wasEmpty && emails.length > 0) {
        selectEmail(emails[emails.length - 1].id);
      }
    }
  } catch(e) {}
}

async function clearEmails() {
  try {
    await fetch('/api/emails', { method: 'DELETE' });
    emails = [];
    selectedId = null;
    renderList();
    document.getElementById('preview').innerHTML =
      '<div id="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg><p>No email selected</p></div>';
  } catch(e) {}
}

renderList();
fetchEmails();
setInterval(fetchEmails, 2000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// SMTP DATA phase parser
// ---------------------------------------------------------------------------

/**
 * Handle incoming data on a receiving SMTP socket.
 * Returns a completed ReceivedEmail if one was received, otherwise null.
 */
function processSmtpData(
  conn: SmtpConnection,
  chunk: Buffer | Uint8Array,
  emails: ReceivedEmail[],
  socket: any,
): void {
  conn.lineBuffer += Buffer.from(chunk).toString("utf8");
  const lines = conn.lineBuffer.split("\r\n");
  conn.lineBuffer = lines.pop()!; // keep partial line

  for (const line of lines) {
    const upper = line.toUpperCase();

    switch (conn.state) {
      case "ready":
        if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
          conn.state = "after-ehlo";
          socket.write(`250-localhost\r\n250 OK\r\n`);
        } else if (upper.startsWith("QUIT")) {
          conn.state = "done";
          socket.write(`221 Bye\r\n`);
          socket.end();
        } else {
          socket.write(`502 Not implemented\r\n`);
        }
        break;

      case "after-ehlo":
        if (upper.startsWith("MAIL FROM")) {
          const match = line.match(/MAIL FROM:\s*<?([^>]+)>?/i);
          conn.mailFrom = match?.[1]?.trim() ?? line;
          conn.state = "after-mail-from";
          socket.write(`250 OK\r\n`);
        } else if (upper.startsWith("QUIT")) {
          conn.state = "done";
          socket.write(`221 Bye\r\n`);
          socket.end();
        } else {
          socket.write(`503 Bad sequence\r\n`);
        }
        break;

      case "after-mail-from":
        if (upper.startsWith("RCPT TO")) {
          const match = line.match(/RCPT TO:\s*<?([^>]+)>?/i);
          conn.rcptTo = match?.[1]?.trim() ?? line;
          conn.state = "after-rcpt-to";
          socket.write(`250 OK\r\n`);
        } else if (upper.startsWith("QUIT")) {
          conn.state = "done";
          socket.write(`221 Bye\r\n`);
          socket.end();
        } else {
          socket.write(`503 Bad sequence\r\n`);
        }
        break;

      case "after-rcpt-to":
        if (upper.startsWith("DATA")) {
          conn.state = "collecting-data";
          conn.dataLines = [];
          socket.write(`354 Start mail input; end with <CRLF>.<CRLF>\r\n`);
        } else if (upper.startsWith("QUIT")) {
          conn.state = "done";
          socket.write(`221 Bye\r\n`);
          socket.end();
        } else {
          socket.write(`503 Bad sequence\r\n`);
        }
        break;

      case "collecting-data":
        if (line === ".") {
          // End of message — parse and store
          const raw = conn.dataLines
            .map((l) => (l.startsWith("..") ? l.slice(1) : l)) // dot-destuff
            .join("\r\n");
          const parsed = parseEmailBody(raw);
          const email: ReceivedEmail = {
            id: Bun.randomUUIDv7(),
            from: conn.mailFrom,
            to: conn.rcptTo,
            subject: parsed.subject,
            html: parsed.html,
            text: parsed.text,
            receivedAt: new Date().toISOString(),
          };
          emails.push(email);
          // Keep the most recent 200 emails to prevent unbounded memory growth
          if (emails.length > 200) emails.splice(0, emails.length - 200);
          // Reset for next message on same connection
          conn.mailFrom = "";
          conn.rcptTo = "";
          conn.dataLines = [];
          conn.state = "after-ehlo";
          socket.write(`250 OK\r\n`);
        } else {
          conn.dataLines.push(line);
        }
        break;

      case "done":
        // Connection is being closed; ignore trailing input
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a local dev mail server — SMTP receiver + browser UI.
 *
 * Captures all outgoing emails in memory. No Docker required.
 *
 * @example
 * ```ts
 * // src/server.ts (dev only)
 * import { createDevMailServer, createMailer, createSmtpTransport } from "bunbase";
 *
 * if (process.env.NODE_ENV !== "production") {
 *   const devMail = createDevMailServer();
 *   console.log(`Dev mail UI: ${devMail.url}`);
 * }
 *
 * const mailer = createMailer({
 *   from: "App <noreply@tasks.local>",
 *   appUrl: "http://localhost:3000",
 *   transport: createSmtpTransport({ host: "localhost", port: 1025 }),
 * });
 * ```
 */
export function createDevMailServer(config: DevMailServerConfig = {}): DevMailServer {
  const smtpPort = config.smtpPort ?? 1025;
  const httpPort = config.httpPort ?? 1026;
  const hostname = config.hostname ?? "localhost";

  const emails: ReceivedEmail[] = [];

  // ── SMTP TCP server ────────────────────────────────────────────────────────
  const smtp = Bun.listen<SmtpConnection>({
    hostname,
    port: smtpPort,
    socket: {
      open(socket) {
        socket.data = {
          state: "ready",
          mailFrom: "",
          rcptTo: "",
          dataLines: [],
          lineBuffer: "",
        };
        socket.write(`220 ${hostname} ESMTP BunBase Dev\r\n`);
      },
      data(socket, chunk) {
        try {
          processSmtpData(socket.data, chunk, emails, socket);
        } catch {
          // Swallow parse errors — dev server should never crash
        }
      },
      close() {},
      error(_socket, _error) {},
    },
  });

  // ── HTTP web UI ────────────────────────────────────────────────────────────
  const uiHtml = buildWebUiHtml(httpPort);

  const http = Bun.serve({
    hostname,
    port: httpPort,
    routes: {
      "/": new Response(uiHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),

      "/api/emails": {
        GET() {
          // Return lightweight list (no html body to keep payload small)
          return Response.json(
            emails.map((e) => ({
              id: e.id,
              from: e.from,
              to: e.to,
              subject: e.subject,
              receivedAt: e.receivedAt,
            })),
          );
        },
        DELETE() {
          emails.splice(0, emails.length);
          return new Response(null, { status: 204 });
        },
      },

      "/api/emails/:id": {
        GET(req) {
          const email = emails.find((e) => e.id === req.params.id);
          if (!email) return new Response("Not Found", { status: 404 });
          return Response.json(email);
        },
      },

      "/api/emails/:id/html": {
        GET(req) {
          const email = emails.find((e) => e.id === req.params.id);
          if (!email) return new Response("Not Found", { status: 404 });
          return new Response(email.html, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });

  const url = `http://${hostname}:${httpPort}`;

  return {
    smtp,
    http,
    emails,
    url,
    stop() {
      smtp.stop(true);
      http.stop(true);
    },
  };
}
