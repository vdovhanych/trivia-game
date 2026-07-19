# Duel Trivia

Two-player, turn-based trivia duel played in the browser. Player 1 creates a
room and shares a link; Player 2 opens it and the battle begins — 10 rounds,
20 questions, fastest correct answers win.

- **Backend:** Node.js 22, Express + `ws`, all state in memory (no database)
- **Frontend:** single-page vanilla JS/CSS, no build step
- **Deps:** `express` and `ws` only

## Quick start (Docker)

```sh
docker compose up -d --build
```

Open <http://localhost:3000>, create a game, and open the shared link in a
second browser (or incognito window) to play against yourself.

## Quick start (bare Node)

```sh
npm install
node server.js          # listens on :3000 (override with PORT=…)
```

## How it works

- Rooms are 4-character codes (`ABCDEFGHJKMNPQRSTUVWXYZ23456789` alphabet)
  created via `POST /api/rooms`; the join link is `https://host/#/room/CODE`.
- A game is 10 rounds; players alternate turns, one question per turn
  (20 questions total, no repeats within a game).
- Each turn has a **server-authoritative 20-second timer**. A correct answer
  scores 100 points plus a time bonus (`floor(secondsRemaining × 5)`, max
  +100). Wrong answers and timeouts score 0.
- The waiting player spectates the same question and sees the reveal.
- Correct answer indexes are never sent to clients before the reveal;
  answer choices are re-shuffled server-side per serve.
- Reconnects are seamless: the client keeps a `playerId` in `localStorage`
  and is re-attached to its seat with the current game state. If an opponent
  stays disconnected for 2+ minutes mid-game, you can claim the win.
- Rooms expire automatically (30 min unstarted, 10 min after finishing,
  60 min hard cap). Restarting the server clears all rooms.

## Deploying behind a reverse proxy

The app serves plain HTTP on port 3000 and expects the proxy to terminate
TLS. WebSockets are served on `/ws`, so the proxy must forward upgrade
headers and keep long-lived connections open.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name trivia.example.com;

    # ssl_certificate ...; ssl_certificate_key ...;

    location /ws {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Kubernetes + cloudflared

`k8s/manifest.yaml` contains a Deployment and a ClusterIP Service — no
persistence, no ingress. Build and push the image, point the manifest at it,
and apply:

```sh
docker build -t ghcr.io/vdovhanych/trivia-game:latest .
docker push ghcr.io/vdovhanych/trivia-game:latest
kubectl apply -f k8s/manifest.yaml
```

Then route a hostname to the service in your cloudflared config:

```yaml
ingress:
  - hostname: trivia.example.com
    service: http://duel-trivia.default.svc.cluster.local:80
  - service: http_status:404
```

cloudflared proxies WebSockets automatically, so `/ws` needs no extra
configuration. Keep `replicas: 1` — game state lives in the pod's memory,
and a second replica would split rooms between pods. A pod restart clears
all active rooms (players just create a new one).

If your ghcr.io package is private, create a pull secret and uncomment the
`imagePullSecrets` block in the manifest:

```sh
kubectl create secret docker-registry ghcr-pull-secret \
  --docker-server=ghcr.io --docker-username=YOUR_GH_USER \
  --docker-password=YOUR_GH_TOKEN
```

### Traefik (labels)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.trivia.rule=Host(`trivia.example.com`)
  - traefik.http.routers.trivia.entrypoints=websecure
  - traefik.http.routers.trivia.tls=true
  - traefik.http.services.trivia.loadbalancer.server.port=3000
```

Traefik handles WebSocket upgrades automatically.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /` | The game (static single page) |
| `POST /api/rooms` | Create a room → `{ "code": "ABCD" }` (rate-limited 10/min/IP) |
| `GET /ws?room=CODE` | WebSocket endpoint |
| `GET /healthz` | Container healthcheck |

## Question bank

205 hand-written questions in `questions.js` across ten categories: Ukraine,
Czech Republic, Video games, Movies & TV, Fun facts, Science & space, Music,
World geography, History, and Food & drink, in three difficulty tiers
(easy / medium / hard). Each game draws 20 without repeats (at least 4
categories represented), so rematches stay fresh. Add your own questions by
appending to the exported array — `correct` is the index into `choices`.
