# SMS / Phone OTP

Passwordless login via SMS one-time codes. Mirrors the email OTP flow but sends codes via a pluggable SMS transport.

## Configuration

```ts
import { createServer, defineConfig } from "bunbase";
import type { SmsTransport } from "bunbase";

const twilioTransport: SmsTransport = {
  async send({ to, body }) {
    await twilioClient.messages.create({ to, from: process.env.TWILIO_FROM, body });
  },
};

createServer({
  schema,
  config: defineConfig({
    auth: {
      mfa: {
        smsOtp: {
          enabled: true,   // default: false
          ttl: 300,        // code TTL in seconds, default: 300 (5 min)
          length: 6,       // digits, default: 6
        },
      },
    },
  }),
  smsTransport: twilioTransport,
});
```

Your users table must have a `phone` column:

```ts
const users = sqliteTable("users", {
  id:    text("id").primaryKey(),
  email: text("email").notNull(),
  phone: text("phone"),
  // ...
});
```

## Endpoints

Both endpoints are CSRF-exempt (same as email OTP).

### POST /auth/sms-otp/request

Sends a code to the given phone number. Always returns 200 to prevent enumeration.

```json
{ "phone": "+15551234567" }
```

**Response:**
```json
{ "message": "If an account with that phone exists, a code has been sent." }
```

In development (no SMS transport configured), the code is printed to the server console.

### POST /auth/sms-otp/verify

Verify the code and start a session.

```json
{ "phone": "+15551234567", "code": "123456" }
```

**Response:**
```json
{ "user": { "id": "...", "email": "alice@example.com", "role": "user" } }
```

## Hooks

```ts
defineAuthHooks({
  beforeSmsOtpLogin: async ({ phone, req }) => {
    // throw ApiError to block login
  },
  afterSmsOtpLogin: async ({ user, userId }) => {
    console.log("SMS OTP login:", userId);
  },
});
```

## Client SDK

```ts
// Request a code
await client.auth.smsOtp.request("+15551234567");

// Verify
const { user } = await client.auth.smsOtp.verify("+15551234567", "123456");
```
