# Big 2 Quick Match

A real-time multiplayer Big 2 starter project built with Node.js, Express, Socket.IO, and a responsive browser UI.

## Features
- Public Quick Match queue designed to group four strangers automatically.
- Private rooms with invitation codes and links.
- Server-side dealing and move validation.
- Responsive card table UI.
- Health endpoint at `/health`.

## Requirements
- Node.js 20 or newer
- npm

## Run locally
```bash
npm install
npm start
```
Open http://localhost:3000 in multiple browsers. For testing Quick Match with four real connections, use separate browsers/devices; local-only access does not make the game public.

## Deploy publicly
1. Push this folder to a GitHub repository.
2. Create a new **Web Service** on Render and connect the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy. Render provides a public HTTPS URL.
6. Open the URL on separate devices and test the match flow.

The server listens on `process.env.PORT`, as required by common hosting providers. Socket.IO uses the same origin by default. If hosting the frontend separately, set `CLIENT_ORIGIN` to the frontend origin and configure the Socket.IO client URL in `public/app.js`.

## Important limitations before production
This is a working starter, not a hardened production service. It currently keeps rooms and queues in memory, so a restart clears active games and a single server instance is expected. For horizontal scaling or durable rooms, use a Socket.IO adapter such as Redis and add persistent sessions/rate limits. Reconnection identity and some variant-specific five-card Big 2 comparison rules should be reviewed before a public launch. Test with multiple real clients before sharing widely.

## Rules implemented
- 52 cards, four suits, no jokers.
- Card rank: 3 through A, then 2. Suit order: diamonds, clubs, hearts, spades.
- Singles, pairs, triples, and five-card combinations.
- First play must include 3♦.
- Server-side validation for turns and held cards.
- First player to empty their hand wins.

Big 2 has regional variations. The current combination-ranking rules are documented in the UI and should be reviewed against the preferred local variant.
