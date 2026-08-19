# Hermes-Agent-Desktop-Web

[简体中文](./README.md) | English

Access your Hermes agent from a browser — a web client with the same experience as the official desktop app. No software to install: just open a webpage to chat with your Hermes, including one running on a remote server.

## Why this project exists

There are mainly two Hermes WebUI projects to be found in the community:

- [hermes-webui](https://github.com/nesquena/hermes-webui): too buggy to tolerate; once chat history gets long, the experience becomes a disaster;
- [hermes-studio](https://github.com/EKKOLearnAI/hermes-studio): too heavy and overloaded with features, building far too much on top of Hermes; chats originating from Hermes itself remain read-only, so it is not a good fit.

(There is also [hermes-workspace](https://github.com/outsourc-e/hermes-workspace), but I had not tried it before making this project, so I will leave it aside for now.)

The official Hermes desktop app is itself an Electron application. I also really like how it connects to remote Hermes instances: it relies only on the APIs exposed by the Hermes Gateway Dashboard, which suits deployments where an external project and the official containers run separately. So the question became: could its interface be brought to the browser as-is instead of writing another UI from scratch?

## Features

- **No second runtime**: the web service provides only the browser interface and a stateless proxy; it does not run Hermes itself
- **The full desktop experience**: session management, streaming replies, tool calls, skills, and more
- **Connect to any remote Hermes**: enter an address and you're connected to your gateway (server), accessible from any browser, anywhere
- **Three ways to sign in**: static token, OAuth login, or username/password — matching the Gateway Dashboard's login methods
- **Easy to deploy**: one container and you're up and running
- **Credential storage**: login credentials stay in your own browser; nothing is written to disk on the server

## Quick Start

### Docker Compose deployment (recommended)

Prerequisite: a server with Docker (including the compose plugin).

1. Download `.env.example` and `docker-compose.yml` from this repository and put them together in the target directory

2. Rename `.env.example` to `.env`

   ```bash
   mv .env.example .env
   ```

3. Edit `.env`: **you must set up the gateway's sign-in method**, otherwise you can't log in; you may also adjust the port, allowlist, etc. as needed

4. Start:

   ```bash
   docker compose up -d
   ```

First use:

1. Go to **Settings → Gateway** — the address is already filled in (`http://hermes:9119`), no changes needed;
2. Click probe and sign in as prompted: an OAuth authorization popup, or the username/password set in `.env`;
3. Back to the chat page, start talking to your Hermes.

### Running from source

For developers. Requires Node.js ≥ 22.22, pnpm 11; Deno is also needed for proxy mode:

```bash
pnpm install
pnpm dev  # local experience (bundled mock gateway), or
pnpm dev:remote  # connect to your own gateway
```

## FAQ

**How's the mobile experience?**

It's only _just about usable_: awkward and not especially pleasant. The Hermes Desktop layout and interaction model were never designed for touch devices. Still, compared with projects whose user experience is not very good, I consider this experience sufficient.

**Why can't I complete OAuth login?**

Hermes' official OAuth login requires the callback address to be a local loopback address (`127.0.0.1`):

- **Browser and server on the same machine** (dev environment): the popup completes automatically — nothing to do.
- **Remote access** (phone / public domain): after signing in, the browser jumps to the local `127.0.0.1` and shows "Connection failed" — this is **expected**. Copy the full URL from the address bar and paste it into the "Paste callback URL" input below the login box, and you're done — no SSH tunnel or VPN needed.

This is the official security boundary; this project doesn't bypass it — it just has you carry the code back to the proxy yourself, with the same security properties as the desktop app.

**Where are my credentials stored?**

Connection info is stored in your browser's local storage; login sessions (OAuth / username-password) exist only in the server's memory. The server never saves any credential to disk.

**Is my password safe when I sign in with username/password?**

If you access the site over `http://` (no HTTPS), the username and password travel **in plaintext** and can be seen by anyone on the network path. For any public deployment, put HTTPS in front (e.g. an Nginx / Caddy reverse proxy); on a trusted LAN or VPN it's less of a concern, but HTTPS is still recommended.

**Why can't I connect to the gateway address I entered?**

If you (or the deployer) configured a connection allowlist (`WEB_PROXY_ALLOWED_TARGETS`), only gateways on the allowlist can be connected. This is a restriction deliberately set by the deployer to prevent the server from being abused.

**Which sign-in methods are supported?**

| Method            | When to use                                          |
| ----------------- | ---------------------------------------------------- |
| Static token      | A locally running gateway without login verification |
| OAuth login       | A gateway with official OAuth enabled (recommended)  |
| Username/password | A gateway configured with password login only        |

## Configuration

See [.env.example](.env.example); for the full gateway-side configuration, see the [Hermes Agent official docs](https://hermes-agent.nousresearch.com/docs/user-guide/configuration).

## Acknowledgements

- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

## Sponsor

**[Sponsor me](https://lgck.cc/sponsor)**

Thank you for your support! Your sponsorship keeps me creating!

## Contact

- QQ：3076823485
- QQ Group：[168603371](https://qm.qq.com/q/EikuZ5sP4G)
- Telegram：[@lgc2333](https://t.me/lgc2333)
- Email：<lgc2333@126.com>
