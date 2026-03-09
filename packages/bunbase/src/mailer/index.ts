/**
 * BunBase mailer — bring-your-own-transport email sending.
 * @module
 */

import { defaultEmailVerificationTemplate, defaultPasswordResetTemplate } from "./templates.ts";
import type { Mailer, MailerConfig, SendOptions } from "./types.ts";
import { MailerError } from "./types.ts";

export type {
  EmailMessage,
  EmailVerificationTemplateContext,
  Mailer,
  MailerConfig,
  MailerTemplates,
  PasswordResetTemplateContext,
  SendOptions,
  TemplateResult,
} from "./types.ts";
export { MailerError } from "./types.ts";

/**
 * Create a BunBase mailer from a transport function.
 *
 * The mailer provides three methods:
 * - `send()` — deliver arbitrary app emails
 * - `sendPasswordReset()` — send a formatted password reset email (requires `appUrl`)
 * - `sendEmailVerification()` — send a formatted email verification email (requires `appUrl`)
 *
 * When passed to `createServer({ mailer })`, auth flows (password reset and
 * email verification on registration) are handled automatically.
 *
 * @param config - Mailer configuration including `from`, optional `appUrl`, transport, and templates.
 * @returns A configured `Mailer` instance.
 *
 * @example
 * ```ts
 * import { createMailer } from "bunbase";
 * import { Resend } from "resend";
 *
 * const resend = new Resend(process.env.RESEND_API_KEY);
 *
 * export const mailer = createMailer({
 *   from: "App <noreply@myapp.com>",
 *   appUrl: "https://myapp.com",
 *   transport: async (email) => {
 *     await resend.emails.send({
 *       from: email.from,
 *       to: email.to,
 *       subject: email.subject,
 *       html: email.html,
 *     });
 *   },
 * });
 *
 * // Then in createServer:
 * createServer({ schema, rules, mailer });
 * ```
 */
export function createMailer(config: MailerConfig): Mailer {
  if (!config.from) {
    throw new MailerError("createMailer: 'from' is required");
  }
  if (typeof config.transport !== "function") {
    throw new MailerError("createMailer: 'transport' must be a function");
  }

  async function send(options: SendOptions): Promise<void> {
    const message = {
      from: options.from ?? config.from,
      to: options.to,
      subject: options.subject,
      html: options.html,
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {}),
    };
    try {
      await config.transport(message);
    } catch (err) {
      throw new MailerError(`Failed to send email to ${options.to}: ${String(err)}`, err);
    }
  }

  async function sendPasswordReset(ctx: {
    token: string;
    email: string;
    userId: string;
  }): Promise<void> {
    if (!config.appUrl) {
      throw new MailerError("sendPasswordReset requires 'appUrl' to be set in createMailer config");
    }
    const resetUrl = `${config.appUrl.replace(/\/$/, "")}/auth/reset-password?token=${ctx.token}`;
    const templateFn = config.templates?.passwordReset ?? defaultPasswordResetTemplate;
    const { subject, html, text } = templateFn({ ...ctx, resetUrl });
    await send({ to: ctx.email, subject, html, ...(text !== undefined ? { text } : {}) });
  }

  async function sendEmailVerification(ctx: {
    token: string;
    email: string;
    userId: string;
  }): Promise<void> {
    if (!config.appUrl) {
      throw new MailerError(
        "sendEmailVerification requires 'appUrl' to be set in createMailer config",
      );
    }
    const verifyUrl = `${config.appUrl.replace(/\/$/, "")}/auth/verify-email?token=${ctx.token}`;
    const templateFn = config.templates?.emailVerification ?? defaultEmailVerificationTemplate;
    const { subject, html, text } = templateFn({ ...ctx, verifyUrl });
    await send({ to: ctx.email, subject, html, ...(text !== undefined ? { text } : {}) });
  }

  return { send, sendPasswordReset, sendEmailVerification };
}
