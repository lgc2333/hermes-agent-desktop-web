# Hermes-Agent-Desktop-Web

[简体中文](./README.md) | English

Access your Hermes agent from a browser — a web client with the same experience as the official desktop app. No software to install: just open a webpage to chat with your Hermes, including one running on a remote server.

## Why this project exists

There are mainly two Hermes WebUI projects to be found in the community:

- [hermes-webui](https://github.com/nesquena/hermes-webui): too many bugs to put up with;
- [hermes-studio](https://github.com/EKKOLearnAI/hermes-studio): too heavy and overloaded with features, not a good fit.

The official Hermes desktop app is itself an Electron application. So the idea came up: why not bring it to the browser as-is, instead of writing yet another UI from scratch? This project is the answer — the interface and interactions are identical to the desktop app, and it keeps up with official releases.

## Features

- **The full desktop experience**: session management, streaming replies, tool calls, skills, and more
- **Connect to any remote Hermes**: enter an address and you're connected to your gateway (server), accessible from any browser, anywhere
- **Three ways to sign in**: static token, OAuth login, or username/password — depending on your gateway's configuration
- **Works on phone / tablet / desktop**: responsive UI that stays smooth on mobile
- **Easy to deploy**: one container and you're up and running
- **Credential safety**: login credentials stay in your own browser; nothing is written to disk on the server

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
pnpm dev  # local experience (bundled mock gateway)
pnpm --filter @hermes-web/web dev:remote  # connect to your own gateway
```

## FAQ

**Why can't I complete OAuth login?**

Hermes' official OAuth login requires the callback address to be a loopback address (`127.0.0.1`). After authorization, the browser needs to be able to redirect back to the server's `127.0.0.1` — if you're accessing from a phone or via a public domain, you'll need an SSH tunnel or VPN. This is an official security restriction and cannot be bypassed.

**Why do I have to sign in again after the server restarts?**

Login sessions are only kept in the server's memory and are lost on restart — this is by design: the server never writes any credential to disk. Just sign in once more.

**Where are my credentials stored?**

Connection info is stored in your browser's local storage; login sessions (OAuth / username-password) exist only in the server's memory. The server never saves any credential to disk.

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
