# Island Pay — Netlify + Supabase integration starter

This is a **production-oriented integration scaffold**, not a live payment processor.
It implements the 8.88% / 91.12% allocation in PostgreSQL using integer minor units,
an append-only ledger, customer balance records, manual company withdrawal requests,
and email notifications. It deliberately does **not** pretend to process payments or
send bank/crypto payouts without a provider-specific, verified integration.

## Architecture
- Existing Island Pay frontend remains on Netlify.
- Netlify Functions: `create-deposit`, `payment-webhook`, `request-company-withdrawal`.
- Supabase: authentication, PostgreSQL balances and immutable ledger.
- Resend: transactional email.
- Payment provider: connect Banxa (or another provider) only after confirming Aruba
  onboarding, product availability, webhook signature rules, currencies and settlement.

## Add to your existing repository
Copy these files into the root of your existing GitHub repository. Do not replace your
existing `index.html`, CSS, logo, animations, o/Users/randallmurray/Downloads/island-pay-netlify-starter/netlify
/Users/randallmurray/Downloads/island-pay-netlify-starter/netlify.toml
/Users/randallmurray/Downloads/island-pay-netlify-starter/package.json
/Users/randallmurray/Downloads/island-pay-netlify-starter/README.md
/Users/randallmurray/Downloads/island-pay-netlify-starter/supabaser other pages.

Install dependencies:
```bash
npm install
```

Apply `supabase/migrations/0001_island_pay.sql` to your Supabase project using the
Supabase SQL editor or Supabase CLI.

Set these environment variables in Netlify Site configuration → Environment variables:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` (server-side only; NEVER expose to browser)
- `RESEND_API_KEY`
- `EMAIL_FROM` (must be a verified sender/domain in Resend)
- `ADMIN_EMAIL`
- `PAYMENT_PROVIDER` (leave `unconfigured` until a real adapter is implemented)
- `PAYMENT_WEBHOOK_SECRET` (only if your provider's documented signature scheme is HMAC)
- `SITE_URL`

Deploy to Netlify after setting variables.

## Important integration steps still required
1. **Provider adapter:** implement the exact Banxa API request and webhook signature
   verification from Banxa's current merchant documentation. The included webhook
   returns 501 until this is implemented. Never guess signature headers or payload fields.
2. Configure the provider's webhook URL:
   `https://YOUR-DOMAIN/.netlify/functions/payment-webhook`
3. Set provider events for confirmed/settled successful deposits and reversals.
4. Confirm the provider's settlement model. A database company balance is an internal
   ledger amount, not money already received in your bank or wallet.
5. Add admin authorization/role management before exposing admin operations.
6. Implement provider-specific refunds, chargebacks and payout APIs only after approval.
7. Test in provider sandbox with signed test webhooks before live mode.

## Financial model
All values are integer minor units (e.g. USD cents). The SQL function calculates:
- Company fee: 888 basis points (8.88%)
- Customer credits: remaining 9,112 basis points (91.12%)

The fee is calculated with integer arithmetic and a documented half-up rounding rule.
For currencies with different minor-unit conventions, add currency-aware handling before
launch. Do not mix AWG, USD or crypto token decimals in a single unlabelled balance.

## Security notes
- Never put service-role keys, API secrets, wallet private keys or signing secrets in
  frontend code or GitHub.
- Webhooks must be signature-verified against the provider's official specification.
- The webhook must be idempotent; duplicate provider events must not issue credits twice.
- Customer balances are updated only inside a database transaction.
- Company withdrawals created here are **requests only**; no funds are transferred.
- Have a qualified local legal/compliance and accounting review before accepting deposits
  or operating stored-value/crypto services in Aruba or elsewhere.
