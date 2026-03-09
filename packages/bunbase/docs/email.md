---
title: Email
---

BunBase includes a first-class mailer API for sending auth emails (password reset, email verification) and arbitrary app emails. It is fully optional — zero changes when no mailer is configured.

## Overview

BunBase does not ship with a built-in email provider. Instead, you bring your own transport function and BunBase handles the rest:

- **Password reset** — when a mailer is configured, reset emails are sent automatically. No webhook required.
- **Email verification on registration** — if your `users` table has an `emailVerified` column, a verification email is sent automatically when a user registers.
- **Re-send verification** — a new `POST /auth/request-email-verification` endpoint lets users request a fresh verification link.
- **App emails** — use `mailer.send()` anywhere: hooks, jobs, extend routes.

When no mailer is configured, all existing behavior is unchanged. The webhook (`auth.email.webhook`) continues to work as before.

## Setup

Create a mailer with `createMailer` and one of the built-in transports:

```ts
// src/mailer.ts
import { createMailer, createSmtpTransport } from "bunbase";

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  transport: createSmtpTransport({
    host: process.env.SMTP_HOST ?? "localhost",
    port: Number(process.env.SMTP_PORT ?? 1025),
    ...(process.env.SMTP_USER
      ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS! } }
      : {}),
  }),
});
```

Pass the mailer to `createServer`:

```ts
// src/index.ts
import { createServer } from "bunbase";
import { mailer } from "./mailer";
import * as schema from "./schema";
import { rules } from "./rules";

const bunbase = createServer({ schema, rules, mailer });
bunbase.listen();
```

That's it. Password reset and email verification now work out of the box.

## Dev mail server

BunBase ships a zero-Docker local mail server. It catches all outgoing email and provides a browser UI to inspect them — no real mail provider needed during development.

```ts
// src/server.ts
import { createDevMailServer, createMailer, createSmtpTransport } from "bunbase";

if (process.env.NODE_ENV !== "production") {
  const devMail = createDevMailServer(); // SMTP :1025, UI :1026
  console.log(`Dev mail UI: ${devMail.url}`);
}

const mailer = createMailer({
  from: "App <noreply@myapp.local>",
  appUrl: process.env.APP_URL ?? "http://localhost:3000",
  transport: createSmtpTransport({
    host: "localhost",
    port: 1025, // dev server default
  }),
});
```

Open `http://localhost:1026` in your browser to see incoming emails with a two-panel preview.

**Custom ports:**

```ts
const devMail = createDevMailServer({
  smtpPort: 2525,
  httpPort: 2526,
  hostname: "0.0.0.0",
});
```

**Inspect emails in code/tests:**

```ts
const devMail = createDevMailServer();
// devMail.emails is a live array of ReceivedEmail objects
expect(devMail.emails).toHaveLength(1);
expect(devMail.emails[0].subject).toBe("Verify your email");
devMail.stop(); // closes both SMTP + HTTP servers
```

## Built-in transports

### `createSmtpTransport` — SMTP (built-in)

Bun-native TCP SMTP client. Works with Mailpit, SendGrid SMTP, AWS SES SMTP, and any standard SMTP/SMTPS server. No external packages needed.

```ts
import { createSmtpTransport } from "bunbase";

// Dev / Mailpit (no auth)
transport: createSmtpTransport({ host: "localhost", port: 1025 })

// Production — SMTPS (port 465 with TLS)
transport: createSmtpTransport({
  host: "smtp.sendgrid.net",
  port: 465,
  tls: true,
  auth: { user: "apikey", pass: process.env.SENDGRID_KEY! },
})

// AWS SES SMTP
transport: createSmtpTransport({
  host: "email-smtp.us-east-1.amazonaws.com",
  port: 465,
  tls: true,
  auth: { user: process.env.SES_SMTP_USER!, pass: process.env.SES_SMTP_PASS! },
})
```

> **Note:** `tls: true` uses SMTPS (TLS from the start, port 465). STARTTLS (port 587 upgrade) is not supported — use port 465 with `tls: true` for production.

## Provider examples

Pass any async function to `transport` — use whichever provider or SDK you prefer:

### Resend

```ts
import { createMailer } from "bunbase";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    await resend.emails.send({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  },
});
```

### SendGrid

```ts
import { createMailer } from "bunbase";
import sgMail from "@sendgrid/mail";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    await sgMail.send({
      from: email.from,
      to: email.to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
  },
});
```

### AWS SES

```ts
import { createMailer } from "bunbase";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const ses = new SESClient({ region: process.env.AWS_REGION ?? "us-east-1" });

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    await ses.send(
      new SendEmailCommand({
        Source: email.from,
        Destination: { ToAddresses: [email.to] },
        Message: {
          Subject: { Data: email.subject },
          Body: {
            Html: { Data: email.html },
            ...(email.text ? { Text: { Data: email.text } } : {}),
          },
        },
      }),
    );
  },
});
```

### Postmark

```ts
import { createMailer } from "bunbase";
import * as postmark from "postmark";

const client = new postmark.ServerClient(process.env.POSTMARK_TOKEN!);

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    await client.sendEmail({
      From: email.from, To: email.to, Subject: email.subject,
      HtmlBody: email.html, TextBody: email.text,
    });
  },
});
```

### Nodemailer / SMTP

If you need STARTTLS (port 587) or other nodemailer features not in the built-in transport:

```ts
import { createMailer } from "bunbase";
import nodemailer from "nodemailer";

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    await transport.sendMail({
      from: email.from, to: email.to, subject: email.subject,
      html: email.html, text: email.text,
    });
  },
});
```

### Generic fetch (any REST API)

```ts
import { createMailer } from "bunbase";

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: process.env.APP_URL!,
  transport: async (email) => {
    const res = await fetch("https://api.mailprovider.com/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MAIL_API_KEY}`,
      },
      body: JSON.stringify({
        from: email.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
      }),
    });
    if (!res.ok) {
      throw new Error(`Mail API error: ${res.status} ${res.statusText}`);
    }
  },
});
```

## Auth emails

### Password reset

When a mailer is configured, `POST /auth/request-password-reset` sends a password reset email directly — no webhook configuration required. The mailer constructs the URL automatically from `appUrl`:

```
https://myapp.com/auth/reset-password?token=<token>
```

The user follows the link, which should submit the token to `POST /auth/reset-password`.

> **Webhook fallback**: When both `mailer` and `auth.email.webhook` are configured, the mailer takes precedence and the webhook is not called.

### Email verification on registration

Add an `emailVerified` column to your `users` table:

```ts
// src/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  emailVerified: integer("email_verified").notNull().default(0),
});
```

When a mailer is configured and `auth.emailVerification.autoSend` is `true` (the default), BunBase automatically sends a verification email after every successful registration — fire-and-forget, without delaying the response. The verification URL:

```
https://myapp.com/auth/verify-email?token=<token>
```

The user follows the link, which should submit the token to `POST /auth/verify-email`.

### Re-sending verification emails

Use the new endpoint to send a fresh verification link:

```
POST /auth/request-email-verification
```

```bash
curl -X POST http://localhost:3000/auth/request-email-verification \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com"}'
```

Always returns `200` (anti-enumeration). Returns `503` if no mailer is configured.

Or via the client SDK:

```ts
await client.auth.requestEmailVerification("user@example.com");
```

## Custom templates

Override the default templates for any auth email:

```ts
import { createMailer } from "bunbase";

export const mailer = createMailer({
  from: "App <noreply@myapp.com>",
  appUrl: "https://myapp.com",
  transport: async (email) => { /* ... */ },
  templates: {
    passwordReset: ({ resetUrl, email }) => ({
      subject: "Reset your password",
      html: `
        <p>Hi,</p>
        <p>Reset your password for <strong>${email}</strong>:</p>
        <p><a href="${resetUrl}">Click here</a></p>
        <p>Link expires in 1 hour.</p>
      `,
      text: `Reset your password: ${resetUrl}`,
    }),

    emailVerification: ({ verifyUrl, email }) => ({
      subject: "Verify your email",
      html: `
        <p>Thanks for signing up with ${email}!</p>
        <p><a href="${verifyUrl}">Verify your email address</a></p>
      `,
    }),
  },
});
```

### Template context

**`passwordReset` context:**

| Field | Type | Description |
|---|---|---|
| `token` | `string` | Raw reset token |
| `resetUrl` | `string` | Full URL: `appUrl + /auth/reset-password?token=...` |
| `email` | `string` | Recipient email address |
| `userId` | `string` | User ID |

**`emailVerification` context:**

| Field | Type | Description |
|---|---|---|
| `token` | `string` | Raw verification token |
| `verifyUrl` | `string` | Full URL: `appUrl + /auth/verify-email?token=...` |
| `email` | `string` | Recipient email address |
| `userId` | `string` | User ID |

## Sending app emails

Use `mailer.send()` anywhere in your codebase — hooks, jobs, extend routes:

**In a hook:**

```ts
import { defineHooks } from "bunbase";
import { mailer } from "./mailer";
import { orders } from "./schema";

export const orderHooks = defineHooks(orders, {
  afterCreate: async ({ record }) => {
    await mailer.send({
      to: record.customerEmail,
      subject: `Order #${record.id} confirmed`,
      html: `<p>Your order has been placed.</p>`,
    });
  },
});
```

**In a scheduled job:**

```ts
import { defineJobs } from "bunbase";
import { mailer } from "./mailer";

export const jobs = defineJobs([
  {
    name: "weekly-digest",
    schedule: "0 9 * * 1", // 9 AM every Monday
    run: async ({ db }) => {
      const users = await db.select().from(usersTable);
      for (const user of users) {
        await mailer.send({
          to: user.email,
          subject: "Your weekly digest",
          html: `<p>Here's what happened this week...</p>`,
        });
      }
    },
  },
]);
```

**In an extend route:**

```ts
createServer({
  schema, rules, mailer,
  extend: ({ db }) => ({
    "/api/invite": {
      async POST(req) {
        const { email } = await req.json();
        await mailer.send({
          to: email,
          subject: "You've been invited",
          html: `<a href="https://myapp.com/join">Join now</a>`,
        });
        return Response.json({ sent: true });
      },
    },
  }),
});
```

## Configuration reference

### `createServer` options

| Option | Type | Description |
|---|---|---|
| `mailer` | `Mailer` | Optional mailer instance from `createMailer`. When present, auth emails are handled automatically. |

### `createMailer` options

| Option | Type | Required | Description |
|---|---|---|---|
| `from` | `string` | Yes | Default sender address, e.g. `"App <noreply@myapp.com>"` |
| `appUrl` | `string` | For auth emails | Base URL used to construct reset/verification links |
| `transport` | `(email: EmailMessage) => Promise<void>` | Yes | Function that delivers the email. Use `createSmtpTransport()` or any custom async function. |
| `templates` | `MailerTemplates` | No | Override default auth email HTML templates |

### `createSmtpTransport` options

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | — | SMTP server hostname |
| `port` | `number` | — | SMTP server port (25, 465, 587, 1025…) |
| `tls` | `boolean` | `false` | Enable SMTPS (TLS from connection start, port 465) |
| `auth.user` | `string` | — | AUTH LOGIN username |
| `auth.pass` | `string` | — | AUTH LOGIN password |

### `createDevMailServer` options

| Option | Type | Default | Description |
|---|---|---|---|
| `smtpPort` | `number` | `1025` | TCP port for the SMTP receiver |
| `httpPort` | `number` | `1026` | HTTP port for the web UI |
| `hostname` | `string` | `"localhost"` | Hostname to bind to |

### `auth.emailVerification` config

| Option | Type | Default | Description |
|---|---|---|---|
| `autoSend` | `boolean` | `true` | Send a verification email automatically on registration (requires mailer + `emailVerified` column) |

```ts
defineConfig({
  auth: {
    emailVerification: {
      autoSend: false, // disable auto-send (send manually via hooks instead)
    },
  },
});
```

### Interaction with `auth.email.webhook`

| Scenario | Behavior |
|---|---|
| Mailer only | Mailer sends all auth emails |
| Webhook only | Webhook receives password reset payloads (unchanged behavior) |
| Both mailer + webhook | Mailer takes precedence; webhook is not called |
| Neither (dev mode) | Token is logged to the console |
| Neither (production) | Warning logged; 200 returned (anti-enumeration) |

## Error handling

`mailer.send()` throws `MailerError` when the transport fails:

```ts
import { MailerError } from "bunbase";

try {
  await mailer.send({ to: "user@example.com", subject: "Hi", html: "<p>Hi</p>" });
} catch (err) {
  if (err instanceof MailerError) {
    console.error("Email delivery failed:", err.message, err.cause);
  }
}
```

In auth flows (password reset, email verification), transport failures are caught and logged — they never surface as errors to the client (anti-enumeration). The endpoint always returns 200.

## Without a mailer

When no mailer is configured, behavior is unchanged from today:

- **Development** — password reset tokens are printed to the console.
- **Production with webhook** — password reset payloads are POSTed to `auth.email.webhook`.
- **Production without webhook** — a warning is logged; the endpoint returns 200 (anti-enumeration).

Email verification via `POST /auth/verify-email` continues to work when tokens are created externally (e.g., via a webhook flow you manage yourself).
