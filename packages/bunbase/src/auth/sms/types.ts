/**
 * SMS transport types for phone-based OTP authentication.
 * @module
 */

export interface SmsMessage {
  to: string;
  body: string;
}

export interface SmsTransport {
  send(message: SmsMessage): Promise<void>;
}
