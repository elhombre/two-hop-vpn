# Two-hop VPN

Two-hop VPN is a manual deployment toolkit for a two-node VPN path:

```text
Client
  -> RF Entry
  -> Foreign Exit
  -> Internet
```

This is an experimental project. The current configuration model supports a simple route with one RF Entry and one or more manually declared Foreign Exit nodes. It is intended to make the existing implementation easy to inspect and run manually, not to provide a full multi-node control plane.

The runtime config is intentionally a little more structured than a hard-coded one-entry, one-exit setup. Route-mapping fields such as `countries`, `exitPools`, `peers`, `entryNode`, `exitPool`, and `exitNode` keep each route explicit and leave room for a future multi-entry/multi-exit model without changing the basic profile shape.

## Why

Many VPN setups expose a foreign server directly to the client. That can be fragile when direct international connectivity is unstable, filtered, or inconvenient to operate. Two-hop VPN separates the public entry point from the internet exit point: users import one stable subscription URL and connect to one RF Entry hostname, while the operator can place, replace, or reconfigure Foreign Exit nodes independently.

This project is for operators who want a reproducible, inspectable deployment instead of a black-box panel. It packages the current implementation into portable node bundles that can be built on a local machine or CI, copied to VPS hosts, customized with explicit JSONC runtime configs, and operated with Docker Compose plus `manage.sh`.

## Terminology

- `Build config`: `config/examples/build.example.jsonc`. It tells the builder which role bundles to create and which Docker images they use.
- `Bundle`: a portable `vpn-bundle/` directory or `.tar.gz` archive for one role, either RF Entry or Foreign Exit. It contains `docker-compose.yml`, `manage.sh`, metadata, templates, and an editable runtime config example. The same Foreign Exit bundle can be reused on multiple VPS hosts with different `runtime.jsonc` files.
- `Client`: the user's VPN app. The examples are designed around clients that can import VLESS Reality subscription links.
- `clientAccess`: the required manual client access block in `runtime.jsonc`. It defines the subscription token, client-facing Reality parameters, inter-node transport settings, and profile UUIDs used by generated Xray configs.
- `Docker-only bundle`: a bundle built with `--save-images`, so the VPS can load images from `images/*.tar` instead of pulling them from registries.
- `Exit pool`: a named group of Foreign Exit nodes for a country. The RF Entry example uses one pool, `exit-pool-de`, with two optional Foreign Exit nodes.
- `exitNode`: an optional `clientAccess.profiles[]` field that pins one client-visible profile to one concrete Foreign Exit node from its `exitPool`.
- `Foreign Exit`: the exit VPS outside Russia, or in whichever country you want traffic to exit from. It receives traffic from RF Entry and sends it to the internet, so websites see the Foreign Exit as the source IP.
- `Generated runtime artifacts`: files under `vpn-bundle/config/` created by `./manage.sh generate-config`, including Xray, routing, HAProxy, Caddy, and subscription output.
- `Inter-node transport`: the RF Entry to Foreign Exit connection. By default it uses VLESS Reality without XTLS Vision flow and with Xray mux enabled, so browser traffic can reuse a small number of long-lived TCP connections between VPS hosts.
- `Profile`: one client-visible connection option inside the subscription, such as `Germany - Foreign 1`. In the example config it is represented by `clientAccess.profiles[]`.
- `RF Entry`: the Russian Federation entry VPS, usually a server located in Russia. Users connect to this node first. It accepts VLESS Reality on `443/tcp`, serves the subscription domain, and forwards traffic to a Foreign Exit.
- `Runtime config`: `runtime.jsonc` on a VPS. It is copied from `example.config.jsonc` and then customized with real domains, Reality keys, short IDs, tokens, and UUIDs.
- `Stable transport`: the implemented transport mode in this repository. It uses Xray-core with VLESS Reality over TCP/443.
- `Subscription URL`: the HTTPS URL imported by the client, for example `https://sub.example.com/sub/<token>`. It points to generated profile links.
- `Two-hop path`: the full route `Client -> RF Entry -> Foreign Exit -> Internet`. The client does not connect directly to Foreign Exit.
- `VLESS Reality`: the Xray protocol/security combination used for the public client connection and the RF-to-Foreign connection. Reality requires a private/public key pair and short IDs.
- `Xray-core`: the proxy runtime used inside the RF Entry and Foreign Exit containers.

The client connects only to the RF Entry node. The RF Entry node accepts the public VLESS Reality connection, routes the selected profile to a Foreign Exit node, and the Foreign Exit node sends traffic to the internet. This keeps the user-facing endpoint stable while the exit side can live in another country.

The repository builds portable `vpn-bundle` archives for both node roles. A bundle contains Docker Compose configuration, role metadata, a POSIX `manage.sh` helper, a bundled Node.js management helper, and an editable runtime configuration example. The concrete node identity comes from `runtime.jsonc`, not from the bundle. The VPS does not need Node.js, npm, git, or the source repository.

## What This Repository Provides

- RF Entry and Foreign Exit role bundle generation.
- A simple one-entry deployment model with one or more manually declared Foreign Exit profiles.
- VLESS Reality TCP/443 stable transport through Xray-core.
- A generated subscription file served from the RF Entry node.
- HAProxy and Caddy edge routing on the RF Entry node, so the same VPS can publish both Reality and HTTPS subscription domains on `80/tcp` and `443/tcp`.
- Runtime validation and config generation through `./manage.sh`.
- Docker-only VPS operation when bundles are built with saved images.

## Repository Layout

```text
config/examples/
  build.example.jsonc
  rf-entry.config.jsonc
  foreign-exit.config.jsonc
scripts/
  build-bundles.mjs
templates/
  manage.sh.template
  manage.mjs
```

Generated output is written to `dist/`, which is ignored by Git.

## Requirements

Build host:

- Node.js 22 or another recent Node.js version with ESM support.
- `tar`.
- POSIX shell for local syntax checks.
- Docker, only when using `--save-images`.

Each VPS:

- Docker Engine.
- Docker Compose plugin.
- POSIX `sh`.
- `tar` and `gzip`.
- Basic coreutils.

The VPS does not need Node.js, npm, git, build tools, or this source repository.

## Build Bundles

From the repository root:

```sh
npm run build
```

This creates:

```text
dist/
  build-plan.generated.json
  rf-entry-linux-amd64.tar.gz
  foreign-exit-linux-amd64.tar.gz
  .build/
    rf-entry-linux-amd64/vpn-bundle/
    foreign-exit-linux-amd64/vpn-bundle/
```

For Docker-only VPS hosts, include Docker images in each bundle:

```sh
npm run build:images
```

Direct CLI usage:

```sh
node scripts/build-bundles.mjs \
  --build-config config/examples/build.example.jsonc \
  --target-platform linux/amd64
```

Useful options:

- `--build-config <path>`: JSONC build config path.
- `--target-platform <platform>`: build only this target platform. May be repeated.
- `--out-dir <path>`: output directory. Defaults to `dist`.
- `--no-archive`: render bundle directories without `.tar.gz` archives.
- `--save-images`: pull and save runtime Docker images into each bundle.
- `-h`, `--help`: show help.

## Configure DNS

The RF Entry node uses two public hostnames:

```text
vpn.example.com -> RF Entry VPS IP
sub.example.com -> RF Entry VPS IP
```

- `vpn.example.com` is the VLESS Reality hostname from `node.host`.
- `sub.example.com` is the HTTPS subscription hostname from `project.subscriptionBaseUrl`.

Each Foreign Exit node needs its own public hostname:

```text
foreign.example.com -> Foreign Exit VPS IP
foreign-2.example.com -> optional second Foreign Exit VPS IP
```

You do not need to buy a domain for a basic test deployment. Any public DNS or dynamic DNS provider is enough, as long as you can point hostnames to the VPS public IP addresses. For example, a free dynamic DNS service such as DuckDNS can provide hostnames under `duckdns.org`.

Example with DuckDNS-style names:

```text
vpn-example.duckdns.org -> RF Entry VPS IP
sub-example.duckdns.org -> RF Entry VPS IP
exit-example.duckdns.org -> Foreign Exit VPS IP
exit-2-example.duckdns.org -> optional second Foreign Exit VPS IP
```

For production use, a domain you control is preferable. Free dynamic DNS services can change limits, availability, or terms independently of this project.

## Prepare Runtime Configs

Each role bundle includes a generic `example.config.jsonc`. On the target VPS, copy it to `runtime.jsonc` and edit it before starting services. The bundle only enforces the role: an RF Entry bundle requires `runtime.node.role = "rf-entry"`, and a Foreign Exit bundle requires `runtime.node.role = "foreign-exit"`.

```sh
cp example.config.jsonc runtime.jsonc
```

Replace at least:

- `project.subscriptionBaseUrl`.
- RF Entry `node.host`.
- Foreign Exit `node.host`.
- RF Entry `peers[].host`.
- RF Entry `node.reality.privateKey`.
- RF Entry `node.reality.publicKey`.
- RF Entry `clientAccess.reality.publicKey`.
- Foreign Exit `node.reality.privateKey`.
- Foreign Exit `node.reality.publicKey`.
- RF Entry `peers[].reality.publicKey`.
- Reality `shortIds`.
- `clientAccess.user.subscriptionToken`.
- `clientAccess.profiles[].uuid`.
- `clientAccess.profiles[].exitNode`, if you add, remove, or rename Foreign Exit nodes.

Do not commit real `runtime.jsonc` files, Reality private keys, subscription tokens, UUIDs, or production environment files.

Generate Reality key pairs on a machine with Docker:

```sh
docker run --rm ghcr.io/xtls/xray-core:latest x25519
```

Generate a short ID:

```sh
openssl rand -hex 8
```

Generate a profile UUID:

```sh
docker run --rm node:22-alpine node -e "console.log(crypto.randomUUID())"
```

The UUID used by the RF Entry profile must match the UUID accepted by the Foreign Exit profile.

To expose several Foreign Exit nodes in Hiddify or another subscription client, create one `clientAccess.profiles[]` entry per exit. Each profile must have a unique `id`, `name`, and `uuid`, and should set `exitNode` to the concrete Foreign Exit node:

```jsonc
"profiles": [
  {
    "id": "manual-user-de-foreign-1",
    "name": "Germany - Foreign 1",
    "country": "DE",
    "mode": "stable",
    "entryNode": "rf-1",
    "exitPool": "exit-pool-de",
    "exitNode": "foreign-1",
    "uuid": "00000000-0000-4000-8000-000000000001"
  },
  {
    "id": "manual-user-de-foreign-2",
    "name": "Germany - Foreign 2",
    "country": "DE",
    "mode": "stable",
    "entryNode": "rf-1",
    "exitPool": "exit-pool-de",
    "exitNode": "foreign-2",
    "uuid": "00000000-0000-4000-8000-000000000002"
  }
]
```

The client imports one subscription URL, then shows these profiles as separate connection options. Switching between exits is done in the client; RF Entry does not automatically balance traffic between exits.

The default inter-node transport is defined in `clientAccess.transport`:

```jsonc
"transport": {
  "clientFlow": "xtls-rprx-vision",
  "exitFlow": "none",
  "exitMux": {
    "enabled": true,
    "concurrency": 8
  }
}
```

`clientFlow` is used for Client -> RF Entry links in the subscription. `exitFlow` and `exitMux` are used for RF Entry -> Foreign Exit links. The default keeps Vision on the client-facing hop, but disables Vision and enables mux on the inter-node hop for better stability on commodity VPS networks.

## Client Import URL

After the RF Entry bundle runs `./manage.sh generate-config`, it creates a subscription file for the manual client access user. This is the link you import into Hiddify or another compatible client:

```text
<project.subscriptionBaseUrl>/sub/<clientAccess.user.subscriptionToken>
```

For the default example values:

```text
https://sub.example.com/sub/manual-token-change-me
```

If you use DuckDNS-style names and set:

```jsonc
"project": {
  "subscriptionBaseUrl": "https://sub-example.duckdns.org"
},
"clientAccess": {
  "user": {
    "subscriptionToken": "my-secret-token"
  }
}
```

then import this URL into the client:

```text
https://sub-example.duckdns.org/sub/my-secret-token
```

The local file inside the RF Entry bundle is `public/sub/<token>`, but clients should use the public HTTPS URL, not the filesystem path.

## Deploy RF Entry

Copy the RF Entry archive to the RF VPS:

```sh
scp dist/rf-entry-linux-amd64.tar.gz root@vpn.example.com:/opt/two-hop-vpn/
```

On the RF VPS:

```sh
cd /opt/two-hop-vpn
tar -xzf rf-entry-linux-amd64.tar.gz
cd vpn-bundle
cp example.config.jsonc runtime.jsonc
vi runtime.jsonc
./manage.sh generate-config
./manage.sh up
```

For a bundle built with `npm run build:images`, run `./manage.sh load` before `./manage.sh up`. `./manage.sh doctor`, `./manage.sh validate`, and `./manage.sh status` are useful checks, but they are not required to start the stack.

After `generate-config`, the RF bundle writes the subscription file to:

```text
public/sub/<subscriptionToken>
```

Import this public subscription URL into Hiddify or another compatible client:

```text
https://sub.example.com/sub/<subscriptionToken>
```

## Deploy Foreign Exit

Copy the Foreign Exit archive to the Foreign VPS:

```sh
scp dist/foreign-exit-linux-amd64.tar.gz root@foreign.example.com:/opt/two-hop-vpn/
```

On the Foreign VPS:

```sh
cd /opt/two-hop-vpn
tar -xzf foreign-exit-linux-amd64.tar.gz
cd vpn-bundle
cp example.config.jsonc runtime.jsonc
vi runtime.jsonc
./manage.sh generate-config
./manage.sh up
```

For a bundle built with `npm run build:images`, run `./manage.sh load` before `./manage.sh up`. `./manage.sh doctor`, `./manage.sh validate`, and `./manage.sh status` are useful checks, but they are not required to start the stack.

## Bundle Commands

Run bundle commands inside an unpacked `vpn-bundle/`.

Minimal start sequence after `runtime.jsonc` is ready:

```sh
./manage.sh generate-config
./manage.sh up
```

Command reference:

```sh
./manage.sh doctor
./manage.sh load
./manage.sh validate
./manage.sh generate-config
./manage.sh up
./manage.sh status
./manage.sh ps
./manage.sh logs --tail=100
./manage.sh logs -f
./manage.sh config
./manage.sh restart
./manage.sh down
```

Command summary:

- `doctor`: check Docker, Compose, required files, generated artifacts, and saved images.
- `load`: load Docker images from `images/*.tar`.
- `validate`: validate `runtime.jsonc`.
- `generate-config`: generate Docker runtime artifacts from `runtime.jsonc`.
- `up`: start the Docker Compose stack.
- `down`: stop the stack.
- `restart`: stop and start the stack.
- `status`: show node metadata and `docker compose ps`.
- `ps`: pass arguments to `docker compose ps`.
- `logs`: pass arguments to `docker compose logs`.
- `config`: print Compose config, bundle metadata, and generated runtime files.

`validate` and `generate-config` read `runtime.jsonc` by default. You can pass another config file:

```sh
./manage.sh validate --config-file ../runtime.jsonc
./manage.sh generate-config --config-file ../runtime.jsonc
```

## Local Checks

Check JavaScript syntax:

```sh
node --check scripts/build-bundles.mjs
node --check templates/manage.mjs
```

Build bundle archives:

```sh
npm run build
```

Check generated shell syntax:

```sh
sh -n dist/.build/rf-entry-linux-amd64/vpn-bundle/manage.sh
sh -n dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage.sh
```

Validate bundled example configs:

```sh
env BUNDLE_ROOT=dist/.build/rf-entry-linux-amd64/vpn-bundle \
  node dist/.build/rf-entry-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc

env BUNDLE_ROOT=dist/.build/foreign-exit-linux-amd64/vpn-bundle \
  node dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc
```

Generate runtime artifacts locally:

```sh
env BUNDLE_ROOT=dist/.build/rf-entry-linux-amd64/vpn-bundle \
  node dist/.build/rf-entry-linux-amd64/vpn-bundle/manage/manage.mjs generate-config \
  --config-file example.config.jsonc

env BUNDLE_ROOT=dist/.build/foreign-exit-linux-amd64/vpn-bundle \
  node dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage/manage.mjs generate-config \
  --config-file example.config.jsonc
```

Inspect archives:

```sh
tar -tzf dist/rf-entry-linux-amd64.tar.gz
tar -tzf dist/foreign-exit-linux-amd64.tar.gz
```

## License

MIT. See `LICENSE`.
