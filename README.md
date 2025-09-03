This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/create-next-app).

## Getting Started

### Prerequisites

- Node.js 18+
- bun (`npm install -g bun`)

### Development Setup

1. **Install dependencies:**
```bash
bun install
```

2. **Start Supabase and configure environment:**
```bash
# Terminal 1: Start Supabase
bun supabase:start

# Wait for it to fully start, then in a new terminal:
bun setup:env
```
This will create `.env.development.local` with your local Supabase credentials.
You'll need to provide your QStash token from https://console.upstash.com/qstash

3. **Start the required services in separate terminal windows/tabs:**

**Terminal 1 - Supabase (Database & Auth)**
```bash
bun supabase:start
```
(Skip if already running from step 2)

**Terminal 2 - QStash Tunnel (Job Queue)**
```bash
bun qstash:dev
```
This creates a tunnel for QStash to reach your local API endpoints.

**Terminal 3 - Next.js App**
```bash
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

### Stopping Services

- Stop Next.js and QStash: Press `Ctrl+C` in their terminals
- Stop Supabase: Run `bun supabase:stop`

You can start editing the page by modifying `app/route.ts`. The page auto-updates as you edit the file.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## API Routes

This directory contains example API routes for the headless API app.

For more details, see [route.js file convention](https://nextjs.org/docs/app/api-reference/file-conventions/route).
