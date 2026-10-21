# Hello Stranger: random video chat (WebRTC + Socket.IO)

## Run it
    npm install
    npm start
Open http://localhost:3000 in two tabs (or two devices on the same network over HTTPS) and press Next in each.

Camera access needs HTTPS except on localhost. To test on a phone, use a tunnel (e.g. `npx localtunnel --port 3000`) or deploy behind HTTPS.

## How it works
- `server.js`: matchmaking queue, relays WebRTC offer/answer/ICE, text chat, rate limits, report -> temporary ban.
- `public/index.html`: camera, RTCPeerConnection, chat UI. Media flows peer-to-peer.

## Before going to production
1. **TURN server**: add one in `ICE_SERVERS` (coturn, Twilio, Metered, Cloudflare). Without it, some users cannot connect.
2. **Redis**: move `waiting`, `bans`, `reportCount` to Redis and add `@socket.io/redis-adapter` to run several instances.
3. **Accounts**: require login (Google/phone) so bans mean something; keep persistent bans in PostgreSQL.
4. **Moderation**: NSFW frame detection, human review queue for reports, legal compliance for your region.
5. **HTTPS + reverse proxy** (Nginx/Caddy) with WebSocket upgrade; forward `X-Forwarded-For`.
