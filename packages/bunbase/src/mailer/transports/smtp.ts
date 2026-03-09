/**
 * Built-in SMTP transport for BunBase mailer.
 *
 * Uses Bun.connect() (native TCP) — no external dependencies.
 * Supports plain SMTP (dev/Mailpit) and SMTPS with TLS (port 465, production).
 * @module
 */

import type { EmailMessage } from "../types.ts";
import { MailerError } from "../types.ts";

/**
 * Configuration for the built-in SMTP transport.
 */
export interface SmtpConfig {
  /** SMTP server hostname, e.g. `"localhost"` or `"smtp.sendgrid.net"` */
  host: string;
  /** SMTP server port. Common: 25, 587 (plain/STARTTLS), 465 (SMTPS/TLS). */
  port: number;
  /**
   * Enable TLS from the start of the connection (SMTPS, port 465).
   * Default: `false`.
   * Note: STARTTLS (upgrade on port 587) is not supported — use port 465 with `tls: true` for production.
   */
  tls?: boolean;
  /** Optional AUTH LOGIN credentials. Omit for dev servers (Mailpit, etc.) */
  auth?: {
    user: string;
    pass: string;
  };
}

/** Strip display name from "Display Name <email@example.com>" → "email@example.com" */
function extractEmail(address: string): string {
  const match = address.match(/<([^>]+)>/);
  return match?.[1]?.trim() ?? address.trim();
}

/** Encode string to base64 */
function toBase64(str: string): string {
  return Buffer.from(str, "utf8").toString("base64");
}

/** Wrap base64 string into 76-char lines as required by RFC 2045 */
function wrapBase64(b64: string): string {
  return b64.match(/.{1,76}/g)?.join("\r\n") ?? b64;
}

/**
 * Build the raw RFC 2822 email body.
 * Uses base64 content-transfer-encoding for maximum compatibility.
 * Produces multipart/alternative when both html and text are present.
 */
function buildMessage(email: EmailMessage): string {
  const CRLF = "\r\n";
  const boundary = `bb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const hasText = typeof email.text === "string";

  const baseHeaders = [
    `From: ${email.from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `MIME-Version: 1.0`,
  ];

  if (hasText) {
    return [
      ...baseHeaders,
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrapBase64(toBase64(email.text!)),
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      wrapBase64(toBase64(email.html)),
      ``,
      `--${boundary}--`,
    ].join(CRLF);
  }

  return [
    ...baseHeaders,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    wrapBase64(toBase64(email.html)),
  ].join(CRLF);
}

/**
 * Dot-stuffing: RFC 5321 requires that any line beginning with "." in the DATA
 * body has an extra "." prepended.
 */
function dotStuff(body: string): string {
  return body
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

type SmtpState =
  | "greeting" // waiting for server 220 banner
  | "ehlo" // sent EHLO, waiting for 250 (possibly multi-line)
  | "auth-login" // sent AUTH LOGIN, waiting for 334 (username prompt)
  | "auth-user" // sent username, waiting for 334 (password prompt)
  | "auth-pass" // sent password, waiting for 235 (auth success)
  | "mail-from" // sent MAIL FROM, waiting for 250
  | "rcpt-to" // sent RCPT TO, waiting for 250
  | "data" // sent DATA, waiting for 354
  | "body" // sent message body + ".", waiting for 250
  | "quit" // sent QUIT, waiting for 221
  | "done"; // resolved or rejected

/**
 * Create a built-in SMTP transport for `createMailer`.
 *
 * Works out-of-the-box with Mailpit (dev) and any SMTPS server (production).
 *
 * @example Dev (Mailpit, no auth)
 * ```ts
 * transport: createSmtpTransport({ host: "localhost", port: 1025 })
 * ```
 *
 * @example Production SMTPS (SendGrid, port 465)
 * ```ts
 * transport: createSmtpTransport({
 *   host: "smtp.sendgrid.net",
 *   port: 465,
 *   tls: true,
 *   auth: { user: "apikey", pass: process.env.SENDGRID_KEY! },
 * })
 * ```
 */
export function createSmtpTransport(config: SmtpConfig): (email: EmailMessage) => Promise<void> {
  return (email: EmailMessage): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      let state: SmtpState = "greeting";
      let buffer = "";
      let sock: any = null;
      let settled = false;

      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        state = "done";
        if (err) {
          reject(err);
        } else {
          resolve();
        }
        try {
          sock?.end();
        } catch {
          // ignore close errors
        }
      };

      const fail = (msg: string) => {
        done(new MailerError(`SMTP error [${state}]: ${msg}`));
      };

      const cmd = (line: string) => {
        sock.write(`${line}\r\n`);
      };

      /**
       * Called when we receive the final line of an SMTP response
       * (line[3] === ' ' or response is exactly 3 chars).
       */
      const handleResponse = (code: number, text: string) => {
        switch (state) {
          case "greeting":
            if (code !== 220) {
              fail(`Expected 220 banner, got ${code} ${text}`);
              return;
            }
            state = "ehlo";
            cmd(`EHLO bunbase`);
            break;

          case "ehlo":
            if (code !== 250) {
              fail(`EHLO failed: ${code} ${text}`);
              return;
            }
            if (config.auth) {
              state = "auth-login";
              cmd(`AUTH LOGIN`);
            } else {
              state = "mail-from";
              cmd(`MAIL FROM:<${extractEmail(email.from)}>`);
            }
            break;

          case "auth-login":
            if (code !== 334) {
              fail(`AUTH LOGIN unexpected response: ${code} ${text}`);
              return;
            }
            state = "auth-user";
            cmd(toBase64(config.auth!.user));
            break;

          case "auth-user":
            if (code !== 334) {
              fail(`AUTH username unexpected response: ${code} ${text}`);
              return;
            }
            state = "auth-pass";
            cmd(toBase64(config.auth!.pass));
            break;

          case "auth-pass":
            if (code !== 235) {
              fail(`AUTH failed: ${code} ${text}`);
              return;
            }
            state = "mail-from";
            cmd(`MAIL FROM:<${extractEmail(email.from)}>`);
            break;

          case "mail-from":
            if (code !== 250) {
              fail(`MAIL FROM rejected: ${code} ${text}`);
              return;
            }
            state = "rcpt-to";
            cmd(`RCPT TO:<${extractEmail(email.to)}>`);
            break;

          case "rcpt-to":
            if (code !== 250) {
              fail(`RCPT TO rejected: ${code} ${text}`);
              return;
            }
            state = "data";
            cmd(`DATA`);
            break;

          case "data": {
            if (code !== 354) {
              fail(`DATA rejected: ${code} ${text}`);
              return;
            }
            state = "body";
            const body = dotStuff(buildMessage(email));
            sock.write(`${body}\r\n.\r\n`);
            break;
          }

          case "body":
            if (code !== 250) {
              fail(`Message rejected: ${code} ${text}`);
              return;
            }
            state = "quit";
            cmd(`QUIT`);
            break;

          case "quit":
            // 221 is standard, but also accept anything gracefully
            done();
            break;

          default:
            break;
        }
      };

      /** Process incoming data: buffer, split on CRLF, handle responses. */
      const onData = (chunk: Buffer | Uint8Array) => {
        buffer += Buffer.from(chunk).toString("utf8");
        const lines = buffer.split("\r\n");
        buffer = lines.pop()!; // keep partial last line
        for (const line of lines) {
          if (line.length < 3) continue;
          const code = parseInt(line.slice(0, 3), 10);
          if (Number.isNaN(code)) continue;
          const sep = line[3];
          // " " = final line of response; "-" = continuation (multi-line)
          if (sep === " " || line.length === 3) {
            handleResponse(code, line.slice(4));
          }
          // else: continuation — wait for final line
        }
      };

      Bun.connect({
        hostname: config.host,
        port: config.port,
        tls: config.tls ? true : undefined,
        socket: {
          open(socket) {
            sock = socket;
          },
          data(_socket, chunk) {
            try {
              onData(chunk);
            } catch (err) {
              fail(String(err));
            }
          },
          close(_socket) {
            if (!settled) {
              fail("Connection closed unexpectedly");
            }
          },
          error(_socket, error) {
            fail(error.message);
          },
          connectError(_socket, error) {
            fail(error.message);
          },
        },
      }).catch((err: unknown) => {
        fail(err instanceof Error ? err.message : String(err));
      });
    });
  };
}
