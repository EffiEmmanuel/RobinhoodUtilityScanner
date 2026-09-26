import dns from "node:dns";
import net from "node:net";

/**
 * Process-wide network defaults, applied on import. db.ts imports this
 * first, so every entry point that touches the database gets them — the app
 * (index.ts) and every human-run script (scripts/*.ts), which never run
 * index.ts. Confirmed 2026-09-26: without them a script's first Neon query
 * failed with ETIMEDOUT across all six Neon addresses from the user's Mac,
 * while a raw pg connect with both settings connected in ~6s.
 */

// Confirmed live 2026-09-12 on Railway: every SMTP send failed with
// "connect ENETUNREACH <ipv6 addr>:465" — Node's dns.lookup() (used by
// nodemailer's plain net/tls connect) returned smtp.gmail.com's IPv6 address
// first, and Railway's network has no outbound IPv6 route to it. Worked fine
// locally, where IPv6 routing exists. This changes the DEFAULT lookup order
// for the whole process (Node 18+) rather than patching nodemailer alone —
// any other host with the same "advertises AAAA, can't actually route it"
// problem (RPC, DexScreener, X) gets the same fix for free.
dns.setDefaultResultOrder("ipv4first");
// Confirmed live 2026-09-24: ipv4first alone isn't enough. Node 20's
// "happy eyeballs" connect still races every A and AAAA address and gives
// each attempt only 250ms. From Railway's Singapore region, Neon (us-east-2)
// is ~250ms away, and IPv6 can't route at all, so every attempt timed out.
// Every DB query then failed with AggregateError, and the dashboard hung.
// Turning the race off connects to the first (IPv4) address with the normal
// OS timeout.
net.setDefaultAutoSelectFamily(false);
