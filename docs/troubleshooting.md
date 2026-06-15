# Troubleshooting

This guide focuses on problems observed while preparing the public manual deployment flow.

## First Checks

On each VPS, from inside `vpn-bundle`:

```sh
./manage.sh validate
./manage.sh generate-config
./manage.sh config
./manage.sh ps
./manage.sh logs --tail=100
```

The minimum startup sequence after preparing `runtime.jsonc` is:

```sh
./manage.sh generate-config
./manage.sh up
```

`doctor`, `validate`, and `status` are useful checks, but `generate-config` and `up` are the minimum required commands.

## Subscription URL

The client should usually import the subscription URL, not a local file path:

```text
<project.subscriptionBaseUrl>/sub/<clientAccess.users[].subscriptionToken>
```

Example:

```text
https://sub.example.com/sub/manual-token-change-me
```

The local file inside the RF Entry bundle is:

```text
public/sub/<clientAccess.users[].subscriptionToken>
```

That file is served over HTTPS through HAProxy and Caddy on the RF Entry node.

## Invalid Request User ID

Example log:

```text
proxy/vless/encoding: invalid request user id: <uuid>
```

Meaning:

The Foreign Exit received a VLESS request with a UUID that is not listed in its generated inbound clients.

Most likely causes:

- RF Entry `clientAccess.exitProfiles[].uuid` does not match the Foreign Exit shared exit profile UUID.
- The user subscription uses `clientAccess.users[].profileRefs[].uuid`, but the RF -> Foreign outbound must use `clientAccess.exitProfiles[].uuid`.
- The wrong Foreign Exit runtime config was deployed.
- RF Entry profile points to one `exitNode`, but the selected Foreign Exit runtime config contains a different profile.
- `./manage.sh generate-config` was not run after editing `runtime.jsonc`.
- The service was not restarted after regenerating config.

Checks:

```sh
./manage.sh generate-config
cat config/xray.generated.json
```

On RF Entry, verify the inbound client UUID from `profileRefs[]`, and the outbound user UUID/email from `exitProfiles[]`.

On Foreign Exit, verify the inbound client UUID and email. They must match the RF Entry outbound for that shared exit profile.

## Empty Or Missing UUID In Generated Xray Config

If generated Xray config contains a client without a UUID, `clientAccess.exitProfiles[]` or `clientAccess.users[].profileRefs[]` is malformed.

The current public config section is:

```jsonc
"clientAccess": {
  "exitProfiles": [
    {
      "id": "us-google",
      "uuid": "..."
    }
  ],
  "users": [
    {
      "id": "manual-user",
      "enabled": true,
      "profileRefs": [
        {
          "profile": "us-google",
          "uuid": "..."
        }
      ]
    }
  ]
}
```

Older access sections are not supported. The runtime validator should fail if `clientAccess.exitProfiles[]` is missing, if RF Entry `clientAccess.users[]` is missing, if an enabled user has no profile refs, or if a required UUID is malformed.

## Timeout On Hiddify Or Karing

Symptoms:

- Hiddify times out.
- Karing shows connected, but internal ping fails.
- A profile works once, then reconnects fail.
- Browser traffic stops after a short time.
- Streaming does not work.

Checks:

1. Confirm DNS points to the expected hosts:

```text
RF hostname -> RF Entry VPS IP
Subscription hostname -> RF Entry VPS IP
Foreign hostname -> Foreign Exit VPS IP
```

2. Confirm generated RF Entry outbound points to the intended Foreign Exit host:

```sh
cat config/xray.generated.json
```

Look for the outbound address and Reality settings.

3. Confirm inter-node transport uses no Vision flow and mux:

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

In generated RF Entry `xray.generated.json`, the RF -> Foreign VLESS outbound user should not have a `flow` field, and the outbound should have:

```json
"mux": {
  "enabled": true,
  "concurrency": 8
}
```

In generated Foreign Exit `xray.generated.json`, the inbound client for RF Entry should not have a `flow` field.

4. Regenerate and restart both nodes:

```sh
./manage.sh generate-config
./manage.sh restart
```

## Wrong Exit Is Used

The client connects only to RF Entry. Foreign Exit selection is controlled by the selected subscription profile.

Check RF Entry `clientAccess.exitProfiles[]`:

```jsonc
{
  "name": "USA - Google",
  "exitPool": "exit-pool-us",
  "exitNode": "foreign-us-google"
}
```

Then check the generated RF Entry routing rules:

```sh
cat config/xray.generated.json
```

Each profile email should map to the outbound tag for its selected `exitNode`.

## Reality Key Or Short ID Mismatch

Reality settings must line up between RF Entry peer config and Foreign Exit local node config.

RF Entry peer:

```jsonc
"peers": [
  {
    "id": "foreign-us-google",
    "reality": {
      "publicKey": "...",
      "shortIds": ["..."]
    }
  }
]
```

Foreign Exit local node:

```jsonc
"node": {
  "id": "foreign-us-google",
  "reality": {
    "privateKey": "...",
    "publicKey": "...",
    "shortIds": ["..."]
  }
}
```

The RF Entry peer `publicKey` must be the public key that matches the Foreign Exit private key. The RF Entry outbound uses the first peer `shortIds[]` value as the Reality `shortId`.

Generate a Reality key pair with Xray:

```sh
docker run --rm ghcr.io/xtls/xray-core:latest x25519
```

Generate a short ID:

```sh
openssl rand -hex 8
```

## Role Bundle Mismatch

The RF Entry bundle can only run `runtime.node.role = "rf-entry"`.

The Foreign Exit bundle can only run `runtime.node.role = "foreign-exit"`.

If validation fails with a role mismatch, copy the correct role bundle to the VPS or use the correct runtime config.

The same Foreign Exit bundle can be used for multiple Foreign Exit nodes. The node identity is determined by `runtime.jsonc`.

## DNS And SNI

RF Entry needs two hostnames:

```text
vpn.example.com -> RF Entry VPS IP
sub.example.com -> RF Entry VPS IP
```

`node.host` and `project.subscriptionBaseUrl` hostname must differ, because HAProxy routes by SNI:

- Subscription hostname goes to Caddy/subscription.
- Other TLS traffic goes to Xray Reality.

Each Foreign Exit needs its own hostname:

```text
foreign.example.com -> Foreign Exit VPS IP
```

A free DNS provider such as DuckDNS is enough for testing, as long as the names point to the correct public IP addresses.

## Useful Generated Files

On RF Entry:

- `config/xray.generated.json`: inbound clients, Foreign Exit outbounds, routing rules.
- `config/subscription.generated.json`: subscription metadata and raw links.
- `public/sub/<token>`: served subscription body.
- `config/haproxy.generated.cfg`: SNI edge routing.
- `config/Caddyfile.generated`: subscription HTTPS server.

On Foreign Exit:

- `config/xray.generated.json`: RF Entry inbound clients and direct outbound.
- `config/node.generated.json`: local node identity and Reality settings.

## When In Doubt

Regenerate on both nodes after any runtime change:

```sh
./manage.sh validate
./manage.sh generate-config
./manage.sh restart
```

Then compare:

- RF Entry outbound UUID/email/publicKey/shortId.
- Foreign Exit inbound UUID/email.
- DNS records.
- Client subscription profile names.
