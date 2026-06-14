# Architecture

Two-hop VPN is built around a deliberately small manual deployment model:

```text
Client
  -> RF Entry
  -> Foreign Exit
  -> Internet
```

The client connects only to the RF Entry node. The RF Entry node accepts the public VLESS Reality connection, selects an outbound based on the authenticated profile, forwards traffic to one concrete Foreign Exit node, and the Foreign Exit sends traffic to the internet.

## Role Bundles

The repository builds two reusable role bundles:

- `rf-entry`: contains the RF Entry Docker Compose stack, HAProxy/Caddy edge wiring, Xray, the static subscription server, `manage.sh`, and the Node.js manage helper.
- `foreign-exit`: contains the Foreign Exit Docker Compose stack, Xray, `manage.sh`, and the Node.js manage helper.

Bundles are role-specific, not node-specific. A bundle does not define a real VPS identity, hostname, Reality key, short ID, client UUID, or exit country. Those values come from `runtime.jsonc`.

This means the same `foreign-exit` bundle can be copied to multiple VPS hosts. Each host becomes a different node only after you provide a different `runtime.jsonc`.

## Runtime Config Ownership

`runtime.jsonc` is the source of truth for a live node. It defines:

- `project`: project metadata and subscription base URL.
- `node`: the local VPS identity, role, country, host, ports, and Reality settings.
- `peers`: remote Foreign Exit nodes known by an RF Entry.
- `countries`: country-level routing model.
- `exitPools`: groups of Foreign Exit nodes by country.
- `clientAccess`: subscription user, client-facing Reality settings, transport settings, and profiles.

During `./manage.sh validate` and `./manage.sh generate-config`, the manage helper checks that `runtime.node.role` matches the bundle role. It does not require a specific `runtime.node.id`.

## Generated Artifacts

`./manage.sh generate-config` writes generated runtime files under `config/`:

- `node.generated.json`: normalized local node metadata.
- `runtime.generated.json`: normalized runtime view.
- `routing.generated.json`: profile/routing metadata.
- `subscription.generated.json`: subscription metadata and raw VLESS links on RF Entry.
- `xray.generated.json`: generated Xray config.
- `haproxy.generated.cfg`: generated RF Entry edge config.
- `Caddyfile.generated`: generated RF Entry subscription HTTPS config.

The RF Entry bundle also writes the public subscription file under:

```text
public/sub/<subscriptionToken>
```

Clients should import the HTTPS URL:

```text
<project.subscriptionBaseUrl>/sub/<clientAccess.user.subscriptionToken>
```

## Profile Routing

Each `clientAccess.profiles[]` entry represents one client-visible profile in the subscription.

For a stable profile, the important fields are:

- `id`: internal profile id.
- `name`: name visible in clients such as Hiddify or Karing.
- `country`: country code for routing metadata.
- `mode`: currently `stable` for the implemented VLESS Reality transport.
- `entryNode`: RF Entry node id.
- `exitPool`: exit pool id.
- `exitNode`: optional concrete Foreign Exit node id.
- `uuid`: VLESS user UUID.

When `exitNode` is set, the profile is pinned to one concrete Foreign Exit node. This is the recommended public manual model because it makes each exit appear as a separate client profile. The client can then switch exits manually.

Example:

```jsonc
{
  "id": "manual-user-us-google",
  "name": "USA - Google",
  "country": "US",
  "mode": "stable",
  "entryNode": "rf-1",
  "exitPool": "exit-pool-us",
  "exitNode": "foreign-us-google",
  "uuid": "31e03920-2078-49b9-b56f-c5cda128ccfa"
}
```

The RF Entry generated Xray config creates:

- One inbound client for each profile assigned to the local RF Entry.
- One outbound to the selected Foreign Exit for each stable profile.
- One routing rule mapping the authenticated profile email to the outbound tag.

The Foreign Exit generated Xray config creates:

- One inbound client for each profile that targets the local Foreign Exit node.
- A direct freedom outbound to the internet.

## Subscription Links

The RF Entry subscription contains raw VLESS links. Every link points to the RF Entry public hostname and port, not to a Foreign Exit hostname.

The selected profile controls the second hop:

```text
Client imports subscription
Client selects "USA - Google"
Client connects to RF Entry
RF Entry routes that authenticated user to foreign-us-google
```

This is manual client-side switching. It is not automatic load balancing or health-based failover.

## Edge Routing On RF Entry

The RF Entry bundle publishes `80/tcp` and `443/tcp` through HAProxy.

HAProxy routes by hostname/SNI:

- Subscription hostname -> Caddy -> static subscription server.
- Everything else on TLS -> Xray Reality backend.

This allows one RF VPS to expose both:

- A VLESS Reality endpoint on `443/tcp`.
- An HTTPS subscription URL on `443/tcp`.

Because HAProxy uses SNI routing, `project.subscriptionBaseUrl` hostname must differ from `node.host`.

## Foreign Exit Simplicity

Foreign Exit is intentionally simple:

- It accepts RF Entry traffic over VLESS Reality.
- It authenticates the profile UUID.
- It sends traffic directly to the internet.

Foreign Exit does not serve subscriptions and does not need `clientAccess.user.subscriptionToken` or `clientAccess.reality`.

## Current Boundaries

The current public repository is a manual deployment toolkit. It does not include:

- A control plane.
- Automatic node registration.
- Automatic DNS updates.
- Automatic health-based exit selection.
- Automatic key rotation.
- Multi-entry orchestration.

The config shape is intentionally ready for future multi-entry/multi-exit expansion, but the current behavior is explicit and manual.
