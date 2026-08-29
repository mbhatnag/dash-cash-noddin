# Dash Cash Noddin — Secure Edition

A zero-dependency Node.js classroom marketplace with Buyer/Seller students, Teacher controls, and Admin controls.

## Security upgrades

- New student registration requires a **class join code**.
- PINs must be **6–8 digits**.
- Login attempts are rate-limited: after 5 failed attempts for the same username/IP, login is blocked for 15 minutes.
- Join-code guesses are rate-limited: after 5 failed attempts from an IP, new registrations are blocked for 30 minutes.
- Admin can **disable/enable accounts**. Disabling immediately invalidates that user's active sessions.
- Admin PIN resets also invalidate active sessions for that user.
- Student sellers can still be separately **banned/unbanned from selling**.
- Sessions use HttpOnly + SameSite=Strict cookies, with Secure cookies in production.
- Basic browser security headers are enabled.
- In production, the server refuses to start unless `CLASS_JOIN_CODE` is set.

## Run on a Mac

Requires Node.js 18 or newer.

### Easiest method

Double-click `START-DASH-CASH.command`. It starts the Node server and opens `http://localhost:3000` automatically. Keep the Terminal window open while testing.

If macOS blocks the file the first time, right-click it and choose **Open**.

### Terminal method

```bash
cd dash-cash-noddin-secure-v2
node server.js
```

Then open `http://localhost:3000`. Do not double-click `public/index.html`.

### Local demo accounts

- Admin: `admin` / `900090`
- Teacher: `teacher` / `800080`
- Student: `alex` / `111111`
- Student: `sam` / `222222`
- Local class join code: `NODDIN2026`

These are only for local testing. Do not use them on a public deployment.

## Production settings

Set these environment variables on Railway or another host:

```text
NODE_ENV=production
CLASS_JOIN_CODE=<your secret class code>
ADMIN_PIN=<your private 6-8 digit admin PIN>
TEACHER_PIN=<your private 6-8 digit teacher PIN>
DATA_FILE=/data/data.json
```

Important: `ADMIN_PIN` and `TEACHER_PIN` are used only when a brand-new database is seeded. If the database already exists, change/reset PINs from inside the app.

For Railway, mount a persistent volume at `/data` so balances, inventory, users, and orders survive redeploys.

## Marketplace behavior

- Students can buy and sell.
- Cart items from different sellers become separate orders.
- Dash Cash is reserved while an order is Pending.
- When the seller accepts, Dash Cash moves from buyer to seller.
- Order flow: Pending → Accepted → Ready for Pickup → Completed.
- Buyers can cancel while Pending.
- Sellers can reject Pending orders.
- Inventory is restored on rejection/cancellation.
