# Transport Notes

Two-hop VPN uses Xray-core with VLESS Reality over TCP/443 for the public client-facing hop and for the inter-node hop.

The current default transport split is:

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

This is intentional.

## Client To RF Entry

Client -> RF Entry keeps:

```jsonc
"clientFlow": "xtls-rprx-vision"
```

This keeps the generated client share links compatible with the tested VLESS Reality + Vision setup:

```text
Client -> RF Entry: VLESS Reality TCP/443 with xtls-rprx-vision
```

The client link includes:

- `type=tcp`
- `security=reality`
- `encryption=none`
- `flow=xtls-rprx-vision`
- `sni=<clientAccess.reality.sni>`
- `fp=<clientAccess.reality.fingerprint>`
- `pbk=<clientAccess.reality.publicKey>`
- `sid=<clientAccess.reality.shortId>`

## RF Entry To Foreign Exit

RF Entry -> Foreign Exit uses:

```jsonc
"exitFlow": "none",
"exitMux": {
  "enabled": true,
  "concurrency": 8
}
```

This means the second hop is still VLESS Reality over TCP/443, but without XTLS Vision flow and with Xray mux enabled:

```text
RF Entry -> Foreign Exit: VLESS Reality TCP/443, no Vision flow, mux enabled
```

Reality authentication and camouflage still exist on the inter-node hop. What changes is the VLESS `flow` field and connection reuse behavior.

## Why Vision Was Disabled On The Inter-node Hop

During testing, a two-hop chain with Vision on both hops showed unstable behavior on several non-GCP VPS providers:

- Initial connection sometimes worked.
- Reconnects often timed out.
- Hiddify could time out.
- Karing could show the profile as connected while internal ping failed.
- Browser traffic and streaming could stop after a short time.
- YouTube was unreliable or failed.

The same RF Entry to Foreign Exit path could look healthy for simple single-request tests, which made the failure misleading. The problem appeared mainly under real client traffic and reconnection patterns.

Disabling Vision alone was not enough. A no-flow inter-node hop without mux still showed the same unstable reconnect/time-out pattern.

The stable observed setup was:

```text
Client -> RF Entry: Reality with Vision
RF Entry -> Foreign Exit: Reality without Vision, mux enabled
```

With mux enabled on the RF Entry outbound to the Foreign Exit:

- Reconnects became stable.
- YouTube worked.
- Multiple client devices worked at the same time.
- The same non-GCP exits became usable.

## Why Mux Helps Here

Without mux, real browser or streaming traffic can create many RF Entry -> Foreign Exit TCP connections.

On some VPS providers or routes, bursts of new TCP connections appear to be throttled, delayed, or dropped. This matched the observed pattern:

- One connection may work.
- Repeated reconnects may time out.
- Direct host networking may still look healthy.
- GCP tolerated the pattern better than several commodity VPS providers.

Mux changes the inter-node behavior by reusing a smaller number of long-lived TCP connections between RF Entry and Foreign Exit.

That makes the inter-node hop less sensitive to new-connection bursts and provider-side filtering or anti-abuse heuristics.

## What Is Lost By Disabling Vision On RF To Foreign

Disabling `xtls-rprx-vision` on the inter-node hop may lose some Vision-specific optimization behavior.

Potential tradeoffs:

- Lower theoretical peak throughput in some environments.
- More CPU overhead in some environments.
- Less use of XTLS Vision-specific transport behavior.

What remains:

- Reality public/private key authentication.
- Reality short ID validation.
- SNI/camouflage target configuration.
- TCP/443 transport.
- VLESS user UUID authentication.

For this project, inter-node stability was more important than preserving Vision on the second hop.

## Why Mux Is Not Enabled On Client Links

The subscription links are intended to be simple and broadly compatible with clients such as Hiddify and Karing.

Mux is applied on the server-side RF Entry outbound to Foreign Exit, where the operator controls both ends of the hop. This avoids exposing extra mux assumptions to client applications.

## Current Recommendation

Use this default unless you are deliberately testing a provider-specific transport variation:

```jsonc
"clientFlow": "xtls-rprx-vision",
"exitFlow": "none",
"exitMux": {
  "enabled": true,
  "concurrency": 8
}
```

Keep the same `clientAccess.transport` in RF Entry and Foreign Exit runtime configs, so generated RF outbounds and Foreign inbounds agree on whether the inter-node clients use a VLESS flow.

## Known Limitations

This setup is still a proxy-over-proxy two-hop chain over TCP. It is practical and simple, but it is not a full L3 tunnel.

Future alternatives could include a persistent inter-node tunnel such as WireGuard, but that would be a different feature and is outside the current public manual implementation.
