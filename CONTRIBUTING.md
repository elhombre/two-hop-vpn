# Contributing

Thank you for improving Two-hop VPN.

## Development

Use the existing Node.js scripts and JSONC configuration style. Keep changes focused and avoid mixing feature work with documentation or formatting cleanup.

Run the local checks before opening a pull request:

```sh
node --check scripts/build-bundles.mjs
node --check templates/manage.mjs
npm run build
sh -n dist/.build/rf-entry-linux-amd64/vpn-bundle/manage.sh
sh -n dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage.sh
```

Validate the generated example bundles:

```sh
env BUNDLE_ROOT=dist/.build/rf-entry-linux-amd64/vpn-bundle \
  node dist/.build/rf-entry-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc

env BUNDLE_ROOT=dist/.build/foreign-exit-linux-amd64/vpn-bundle \
  node dist/.build/foreign-exit-linux-amd64/vpn-bundle/manage/manage.mjs validate \
  --config-file example.config.jsonc
```

## Security

Never include real deployment secrets in issues, pull requests, logs, screenshots, or example configs. See `SECURITY.md`.
