/**
 * Mailer types for BunBase email sending.
 * @module
 */

/**
 * A single email message to be delivered.
 */
export interface EmailMessage {
  /** Sender address, e.g. `"App <noreply@myapp.com>"`. Falls back to `MailerConfig.from`. */
  from: string;
  /** Recipient email address. */
  to: string;
  /** Email subject line. */
  subject: string;
  /** HTML body of the email. */
  html: string;
  /** Optional plain-text fallback body. */
  text?: string;
  /** Optional Reply-To address. */
  replyTo?: string;
}

/**
 * Template context passed to the password reset template function.
 */
export interface PasswordResetTemplateContext {
  /** Raw reset token. */
  token: string;
  /** Fully-qualified password reset URL (appUrl + token). */
  resetUrl: string;
  /** Recipient email address. */
  email: string;
  /** User ID. */
  userId: string;
}

/**
 * Template context passed to the email verification template function.
 */
export interface EmailVerificationTemplateContext {
  /** Raw verification token. */
  token: string;
  /** Fully-qualified email verification URL (appUrl + token). */
  verifyUrl: string;
  /** Recipient email address. */
  email: string;
  /** User ID. */
  userId: string;
}

/**
 * Result returned by a template function — subject and HTML body.
 */
export interface TemplateResult {
  /** Email subject line. */
  subject: string;
  /** HTML body. */
  html: string;
  /** Optional plain-text fallback. */
  text?: string;
}

/**
 * Optional template overrides for auth emails.
 */
export interface MailerTemplates {
  /** Override the default password reset email template. */
  passwordReset?: (ctx: PasswordResetTemplateContext) => TemplateResult;
  /** Override the default email verification template. */
  emailVerification?: (ctx: EmailVerificationTemplateContext) => TemplateResult;
}

/**
 * Configuration object passed to `createMailer`.
 */
export interface MailerConfig {
  /**
   * Default sender address for all emails, e.g. `"App <noreply@myapp.com>"`.
   * Individual `send()` calls may override this per-message.
   */
  from: string;
  /**
   * Base URL of your application, e.g. `"https://myapp.com"`.
   * Required when sending auth emails (password reset, email verification)
   * so that token URLs can be constructed.
   */
  appUrl?: string;
  /**
   * Transport function responsible for delivering an email.
   * Receives a fully-populated `EmailMessage` and should throw on failure.
   *
   * @example
   * ```ts
   * transport: async (email) => {
   *   await resend.emails.send({ from: email.from, to: email.to, subject: email.subject, html: email.html });
   * }
   * ```
   */
  transport: (email: EmailMessage) => Promise<void>;
  /** Optional overrides for default auth email templates. */
  templates?: MailerTemplates;
}

/**
 * Options accepted by `Mailer.send()`. `from` is optional and falls back to `MailerConfig.from`.
 */
export type SendOptions = Omit<EmailMessage, "from"> & { from?: string };

/**
 * A configured mailer instance returned by `createMailer`.
 *
 * Use `send()` for arbitrary app emails, and `sendPasswordReset()` /
 * `sendEmailVerification()` for built-in auth flows.
 */
export interface Mailer {
  /**
   * Send an arbitrary email.
   *
   * @param options - Email message options. `from` defaults to `MailerConfig.from`.
   * @throws {MailerError} When the transport throws.
   */
  send(options: SendOptions): Promise<void>;

  /**
   * Send a password reset email using the configured (or default) template.
   *
   * @param ctx - Reset token, recipient email, and user ID.
   * @throws {MailerError} When transport throws or `appUrl` is not configured.
   */
  sendPasswordReset(ctx: { token: string; email: string; userId: string }): Promise<void>;

  /**
   * Send an email verification email using the configured (or default) template.
   *
   * @param ctx - Verification token, recipient email, and user ID.
   * @throws {MailerError} When transport throws or `appUrl` is not configured.
   */
  sendEmailVerification(ctx: { token: string; email: string; userId: string }): Promise<void>;
}

/**
 * Error thrown when email delivery fails.
 *
 * @example
 * ```ts
 * try {
 *   await mailer.send({ to: "...", subject: "...", html: "..." });
 * } catch (err) {
 *   if (err instanceof MailerError) {
 *     console.error("Email failed:", err.message, err.cause);
 *   }
 * }
 * ```
 */
export class MailerError extends Error {
  /** The original error from the transport, if available. */
  override cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "MailerError";
    this.cause = cause;
  }
}
