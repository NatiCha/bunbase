/**
 * Default HTML email templates for BunBase auth flows.
 * @module
 */

import type {
  EmailVerificationTemplateContext,
  PasswordResetTemplateContext,
  TemplateResult,
} from "./types.ts";

/**
 * Default password reset email template.
 *
 * @param ctx - Template context including the reset URL.
 * @returns Subject and HTML body for the password reset email.
 */
export function defaultPasswordResetTemplate(ctx: PasswordResetTemplateContext): TemplateResult {
  return {
    subject: "Reset your password",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#111827;">Reset your password</h1>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
                We received a request to reset the password for your account associated with
                <strong>${ctx.email}</strong>. Click the button below to choose a new password.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td>
                    <a href="${ctx.resetUrl}"
                       style="display:inline-block;padding:12px 24px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:500;">
                      Reset password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
                This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
              </p>
              <p style="margin:0;font-size:13px;color:#9ca3af;word-break:break-all;">
                Or copy and paste this URL: <a href="${ctx.resetUrl}" style="color:#6b7280;">${ctx.resetUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    text: `Reset your password\n\nWe received a request to reset the password for ${ctx.email}.\n\nClick this link to reset your password (expires in 1 hour):\n${ctx.resetUrl}\n\nIf you didn't request this, you can safely ignore this email.`,
  };
}

/**
 * Default email verification template.
 *
 * @param ctx - Template context including the verification URL.
 * @returns Subject and HTML body for the email verification email.
 */
export function defaultEmailVerificationTemplate(
  ctx: EmailVerificationTemplateContext,
): TemplateResult {
  return {
    subject: "Verify your email address",
    html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 0;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:8px;padding:40px;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <tr>
            <td>
              <h1 style="margin:0 0 16px;font-size:24px;font-weight:600;color:#111827;">Verify your email</h1>
              <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">
                Thanks for signing up! Please verify your email address
                <strong>${ctx.email}</strong> by clicking the button below.
              </p>
              <table cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
                <tr>
                  <td>
                    <a href="${ctx.verifyUrl}"
                       style="display:inline-block;padding:12px 24px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:15px;font-weight:500;">
                      Verify email
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 8px;font-size:13px;color:#6b7280;">
                This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
              </p>
              <p style="margin:0;font-size:13px;color:#9ca3af;word-break:break-all;">
                Or copy and paste this URL: <a href="${ctx.verifyUrl}" style="color:#6b7280;">${ctx.verifyUrl}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`,
    text: `Verify your email address\n\nThanks for signing up! Please verify ${ctx.email} by visiting:\n${ctx.verifyUrl}\n\nThis link expires in 24 hours.`,
  };
}
