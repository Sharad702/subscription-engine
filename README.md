# Subscription Billing System (Solana)

A **subscription billing** backend implemented as a Solana program in Rust (Anchor). This project is built for the “Rebuild Backend Systems as On-Chain Rust Programs” challenge: it takes a familiar Web2 pattern (recurring subscriptions) and reimplements its core logic on Solana as a distributed state-machine.

## What’s included

- **On-chain program** (Anchor): create plans, subscribe, renew, cancel, deactivate, close (reclaim rent).
- **Web UI** (React + Vite): connect wallet (Devnet), create plans, subscribe, renew, cancel, close accounts; Dashboard, Browse Plans, My Subscriptions, Cancelled tab.
- **Tests**: TypeScript integration tests (run against local validator).

---

## How it works in Web2

In a typical Web2 subscription system:

- **State** lives in a database: `plans` (id, amount, interval, merchant_id), `subscriptions` (user_id, plan_id, status, next_billing_at).
- **Billing** is driven by a **cron job** or queue: every minute/hour a worker finds subscriptions due for renewal and charges the customer (e.g. via Stripe), then updates `next_billing_at`.
- **Permissions** are enforced by the backend (API keys, sessions, server-side checks).
- **Single source of truth**: your server and DB; you control ordering and consistency.

---

## How it works on Solana

- **State** is in **accounts**:
  - **Plan**: PDA `["plan", merchant_pubkey, plan_id]` — amount (lamports), interval (seconds), active flag, merchant.
  - **Subscription**: PDA `["subscription", subscriber_pubkey, plan_pubkey]` — subscriber, plan, amount, interval, `next_billing_at` (period end / expires_at), `started_at`, status (active/cancelled), `auto_renew`.
- **Billing** has **no cron**: renewal is **user- or relayer-triggered**. Someone calls the `renew` instruction; the program checks `Clock::get().unix_timestamp >= next_billing_at`, then transfers SOL from subscriber to merchant and advances `next_billing_at` by the interval.
- **Permissions** are on-chain: only the **subscriber** (or an authorized relayer) can renew/cancel; the **merchant** creates plans; PDAs tie subscriptions to (subscriber, plan).
- **Single source of truth**: the program and account data on Solana; no central DB.

### Instructions

| Instruction            | Who        | What |
|------------------------|------------|------|
| `create_plan`          | Merchant   | Create a billing plan (plan_id, amount_lamports, interval_secs, name). |
| `create_subscription`  | Subscriber | Create subscription PDA, pay first period (SOL transfer to merchant), set next_billing_at, started_at, auto_renew. |
| `renew`                | Subscriber | Require `current_time >= next_billing_at`; transfer SOL to merchant; set `next_billing_at += interval_secs`. |
| `cancel`               | Subscriber | Set status to Cancelled (no refund). |
| `deactivate_plan`      | Merchant   | Set plan.active = false. No new subscriptions; existing can renew until closed. |
| `close_plan`           | Merchant   | Close inactive plan, reclaim rent to merchant. Plan must be deactivated first. |
| `close_subscription`   | Subscriber | Close cancelled subscription, reclaim rent to subscriber. |
| `check_access`         | Anyone     | **Trustless verification**: succeeds if subscription is Active and `clock < next_billing_at` (not expired). Any service can call this (or read the account) to verify access without your server. |

**Resubscribe:** To subscribe again after cancelling, you must first **Close** the cancelled subscription (to free the PDA), then Subscribe again.

---

## Tradeoffs & constraints

### Web2 vs Solana (summary)

| | Web2 (e.g. Stripe) | Solana (this program) |
|---|-------------------|------------------------|
| **Renewal** | Cron job automatically charges card | User or relayer must send `renew` tx (no auto-renew) |
| **Payment** | Card / UPI / fiat | SOL only (or SPL with extra logic) |
| **State** | Your database | On-chain accounts (globally readable) |
| **Verification** | Your server checks DB | Anyone can call `check_access` or read account (trustless) |
| **Infra** | Server 24/7, webhooks, PCI | Zero server; logic on-chain |

### Detailed tradeoffs

- **No auto-renewal**  
  Web2: a cron job charges the card every period.  
  Solana: no cron on-chain; the user (or a keeper/relayer) must send a `renew` transaction. Future option: automation like [Clockwork](https://clockwork.xyz/) or a keeper bot that calls `renew` for `auto_renew` subscriptions.

- **No fiat**  
  Only SOL (lamports). SPL token support would require Token Program CPI and a mint per plan.

- **Zero infrastructure**  
  No server, no database, no webhooks. The program and accounts are the single source of truth.

- **Globally verifiable**  
  Any frontend or backend can verify “is this subscription active?” by reading the subscription account or calling `check_access` — no need to trust your API.

- **Censorship resistant**  
  Logic lives on-chain; no central party can turn off “subscription checks” by taking down a server.

- **Time**  
  Uses Solana’s `Clock` sysvar (block time). Fine for day/month intervals; not for sub-second precision.

- **Liveness**  
  If nobody calls `renew`, the subscription is past due until a tx is sent. Optional: grace period or PastDue status in a future version.

---

## Build & test

### Prerequisites

- Rust, Solana CLI, Anchor CLI.
- Node 18+ and yarn (or npm) for tests and app.

### Program

```bash
# From repo root (subscription-engine/)
anchor build
```

If you changed account structs and tests fail with decode/offset errors, run `anchor clean && anchor build` then `anchor test` so the validator deploys the latest program.

### Tests (local validator)

```bash
anchor test
```

(Starts a local validator, deploys the program, runs the TypeScript tests in `tests/`.)

### UI

```bash
cd app
npm install
npm run dev
```

- Default RPC: Devnet (`https://api.devnet.solana.com`). If you see **429 Too many requests**, use a custom RPC: create `.env` in `app/` with `VITE_SOLANA_RPC=https://your-devnet-rpc-url` (e.g. free tier from [Helius](https://helius.dev), [QuickNode](https://quicknode.com), etc.) and restart the app.
- Connect a Devnet wallet (e.g. Phantom), then create plans (as merchant), subscribe, renew, cancel, and close from the UI.
- **Tabs:** Dashboard (stats), Create Plan, Browse Plans, My Subscriptions, Cancelled. Plan names can be set when creating; double-click a plan name to edit it.

Production-style build:

```bash
cd app && npm run build
# Serve dist/ with any static host.
```

---

## Deploy to Devnet

1. Configure Solana CLI for Devnet and fund your keypair:
   ```bash
   solana config set --url devnet
   solana airdrop 2
   ```

2. Deploy the program:
   ```bash
   anchor deploy --program-name subscription_engine --provider.cluster devnet --no-idl
   ```
   Use `--no-idl` so Anchor does not create/update the on-chain IDL account (avoids "account already in use" if you deployed before). The app uses the local IDL in `app/src/idl/`.

3. Note the program ID (in `Anchor.toml` and `declare_id!` in the program). The UI uses the IDL in `app/src/idl/subscription_engine.json`; if you deploy with a new program ID, re-build the program and copy the new IDL into the app (or point the app to the new ID).

### Devnet transaction links

After deploying and using the app (or CLI), take any transaction signature and open:

- `https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`

Example (replace with a real signature from your runs):

- Create plan: `https://explorer.solana.com/tx/<SIG>?cluster=devnet`
- Create subscription: `https://explorer.solana.com/tx/<SIG>?cluster=devnet`
- Renew: `https://explorer.solana.com/tx/<SIG>?cluster=devnet`
- Close subscription: `https://explorer.solana.com/tx/<SIG>?cluster=devnet`

---

## Repo layout

```
subscription-engine/
├── programs/
│   └── subscription-engine/
│       └── src/
│           └── lib.rs          # Anchor program (Plan, Subscription, instructions)
├── app/                         # React + Vite UI
│   ├── src/
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── idl/
│   │   │   └── subscription_engine.json
│   │   └── lib/
│   │       └── program.ts       # PDA helpers, getProgram()
│   └── package.json
├── tests/
│   └── subscription-engine.ts  # Integration tests
├── Anchor.toml
└── README.md
```

---

## License

MIT.
# subscription-engine
