# beeper-threema-bridge

A self-hosted Matrix appservice bridge that connects your personal Threema account to [Beeper](https://beeper.com) using the **Threema multi-device protocol**. Free, no Threema Gateway fees, uses your real Threema ID.

## Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │              Docker (outbound only)          │
┌─────────────┐    │  ┌──────────────┐      ┌──────────────┐     │    ┌─────────────────┐
│   Beeper    │◀───┼──│ bbctl-proxy  │◀─────│    Bridge    │─────┼───▶│ Threema Mediator│
│  (Matrix)   │    │  │  (WebSocket) │ HTTP │  (this app)  │ WS  │    │    + CSP Server │
└─────────────┘    │  └──────────────┘      └──────────────┘     │    └─────────────────┘
                    │         internal Docker network              │
                    └──────────────────────────────────────────────┘
```

- Links as an **additional device** to your Threema account (like the desktop app)
- Receives all messages via the D2M (Device-to-Mediator) reflection protocol
- Sends messages via the CSP (Chat Server Protocol) when promoted to leader
- Bridges to Matrix via the standard Application Service API
- **No exposed ports** — both containers make outbound connections only

## Prerequisites

- **Docker** and **Docker Compose**
- **Threema** mobile app (Android/iOS) with multi-device enabled
- **Beeper** account with [`bbctl`](https://github.com/beeper/bridge-manager) installed (for initial setup)

## Quick Start (Docker)

### 1. Clone and enter the project

```bash
git clone <repo-url>
cd beeper-threema
```

### 2. Register the bridge with Beeper

```bash
bbctl login
bbctl register sh-threema
```

This creates a `registration.yaml` file. Make sure it is in the project root.

Set the `url` field in `registration.yaml` to the internal Docker address:

```yaml
url: http://threema-bridge:29318
```

### 3. Link your Threema account

This step must be run **locally** (not in Docker) because it displays a QR code:

```bash
npm install
npm run link-device
```

Scan the QR code with your Threema app:
**Threema → Settings → Linked Devices → Link New Device**

Verify the emoji symbols match, then confirm on your phone. This creates identity files in `data/`.

### 4. Copy bbctl credentials

```bash
mkdir -p bbctl-config
cp ~/.config/bbctl/config.json bbctl-config/
```

### 5. Start with Docker Compose

```bash
docker compose up -d --build
```

That's it. No ports to open, no reverse proxy, no DNS setup needed. Both containers make outbound-only connections.

### View logs

```bash
docker compose logs -f
```

### Stop

```bash
docker compose down
```

## Local Development (without Docker)

### 1. Install dependencies

```bash
npm install
```

### 2. Register, link, and configure

Follow steps 2–3 from the Docker instructions above.

### 3. Start the bridge

```bash
# Terminal 1: bbctl proxy (forwards Beeper events to the bridge)
bbctl proxy -r registration.yaml

# Terminal 2: the bridge itself
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BRIDGE_PORT` | `29318` | HTTP port for the appservice |
| `BRIDGE_HOMESERVER_URL` | `https://matrix.beeper.com/_hungryserv/<user>` | Beeper homeserver URL |
| `BRIDGE_HS_TOKEN` | from registration.yaml | Homeserver token |
| `BRIDGE_AS_TOKEN` | from registration.yaml | Appservice token |
| `BRIDGE_BOT_USER_ID` | `@sh-threemabot:beeper.local` | Bridge bot Matrix user ID |
| `BRIDGE_USER_ID` | `@ccarpo:beeper.com` | Your Beeper Matrix user ID |
| `BRIDGE_USER_ACCESS_TOKEN` | from `~/.config/bbctl/config.json` | Your Beeper access token |
| `BRIDGE_USER_PREFIX` | `@sh-threema_` | Ghost user ID prefix |
| `BRIDGE_USER_SUFFIX` | `:beeper.local` | Ghost user ID suffix |
| `BRIDGE_REGISTRATION_FILE` | `./registration.yaml` | Path to registration file |
| `THREEMA_DATA_DIR` | `./data` | Threema identity & contacts storage |
| `BRIDGE_STATE_DIR` | `./state` | Bridge state persistence |

## Docker Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Bridge container (Node 22 Alpine + tsx) |
| `Dockerfile.bbctl` | Proxy container (Alpine + bbctl binary) |
| `docker-compose.yml` | Orchestrates both services on an internal network |
| `.dockerignore` | Keeps images lean |

## Current Features

- [x] Link as additional device (multi-device QR code flow)
- [x] Receive DM text messages → Matrix
- [x] Send text messages Matrix → Threema
- [x] Reflected messages (messages sent from phone appear in Matrix as you)
- [x] Auto-reconnect with exponential backoff
- [x] Contact display names on Matrix ghosts
- [x] WebSocket + CSP keepalive (prevents idle disconnects)
- [x] Docker deployment (no exposed ports)
- [ ] Group chat bridging
- [ ] Media/file message bridging (download blob → re-upload to Matrix)
- [ ] Typing indicators
- [ ] Read receipts / delivery receipts
- [ ] Emoji reactions
- [ ] Message editing

## How It Works

1. **Device Linking**: Uses the Threema Rendezvous protocol to register as a linked device. The phone shares the identity key, device group key, and contact list.

2. **Mediator Connection**: Connects via WebSocket to the Threema mediator server. Authenticates using the device group public key (DGPK). Receives reflected messages from all devices in the group.

3. **CSP Proxy**: When promoted to leader (when no other device has priority), the bridge can send messages directly through the Threema Chat Server Protocol.

4. **Matrix Bridge**: Runs an HTTP server implementing the Matrix Application Service API. Creates ghost users for Threema contacts and DM rooms for conversations.

5. **bbctl Proxy**: Connects to Beeper's websocket and forwards Matrix events to the bridge's HTTP server. Both bridge and proxy run in Docker with no inbound ports.

## Project Structure

```
src/
├── main.ts                  # Entry point, wires everything together
├── config.ts                # Configuration loader
├── bridge-state.ts          # Room/message mapping persistence
├── matrix/
│   └── appservice.ts        # Matrix AS HTTP server & client helpers
└── threema/
    ├── link-device.ts       # QR code device linking flow
    ├── mediator-client.ts   # D2M WebSocket client (core protocol)
    ├── csp-handler.ts       # CSP handshake & message framing
    ├── rendezvous.ts        # Rendezvous protocol for linking
    ├── rendezvous-crypto.ts # Rendezvous encryption
    ├── device-join.ts       # Device join protocol
    ├── emoji-reactions.ts   # Reaction encoding/decoding
    ├── media-speech.ts      # Audio normalization
    ├── rph-emoji.ts         # RPH emoji display
    └── runtime-paths.ts     # Data directory resolution
```

## License

AGPL-3.0-or-later

## Credits

Protocol implementation derived from [threema-openclaw](https://www.npmjs.com/package/threema-openclaw) (MIT licensed).
