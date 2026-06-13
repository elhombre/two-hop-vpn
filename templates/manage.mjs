#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const bundleRoot = process.env.BUNDLE_ROOT || "/bundle";
const edgePorts = {
  http: 80,
  tls: 443,
  xrayStableBackend: 8443,
  caddyHttp: 8080,
  caddyHttps: 9443,
};

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);

  switch (command) {
    case "validate": {
      const context = await loadContext(args);
      console.log(`Runtime config is valid for ${context.node.id} (${context.node.role})`);
      break;
    }
    case "generate-config": {
      const context = await loadContext(args);
      await generateConfig(context, args);
      console.log(`Generated runtime config for ${context.node.id} (${context.node.role})`);
      break;
    }
    case "doctor-config": {
      const context = await loadContext(args);
      console.log(`OK: runtime config parsed for ${context.node.id}`);
      console.log(`OK: ${context.runtime.nodes.length} node(s), ${context.runtime.countries.length} country/countries`);
      break;
    }
    case "-h":
    case "--help":
    case "help":
    case undefined:
      printHelp();
      break;
    default:
      throw new Error(`Unknown manage helper command: ${command}`);
  }
}

function parseArgs(argv) {
  const args = {
    configFile: "runtime.jsonc",
    outDir: "config",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--config-file":
      case "--config-path":
        args.configFile = readValue(argv, ++index, arg);
        break;
      case "--out-dir":
        args.outDir = readValue(argv, ++index, arg);
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (process.env.MANAGE_CONFIG_FILE) {
    args.configFile = process.env.MANAGE_CONFIG_FILE;
  }

  return args;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: manage.mjs <command> [options]

Commands:
  validate         Validate runtime JSONC for this bundle node.
  generate-config Generate runtime artifacts for this bundle node.
  doctor-config   Print config diagnostics.

Options:
  --config-file <path>  Runtime JSONC path. Defaults to runtime.jsonc.
  --config-path <path>  Alias for --config-file.
  --out-dir <path>      Output directory. Defaults to config.
`);
}

async function loadContext(args) {
  const bundle = await readJson(path.join(bundleRoot, "bundle.json"));
  const runtimePath = resolveBundlePath(args.configFile);
  const runtimeInput = await readJsonc(runtimePath);
  const normalizedRuntime = normalizeRuntime(runtimeInput.value);
  const errors = validateRuntime(normalizedRuntime, bundle);

  const node = normalizedRuntime.nodes.find((candidate) => candidate.id === bundle.nodeId);
  if (!node) {
    errors.push(`runtime config does not contain bundle node ${bundle.nodeId}`);
  } else if (node.role !== bundle.nodeRole) {
    errors.push(`runtime node ${node.id} role ${node.role} does not match bundle role ${bundle.nodeRole}`);
  }

  if (errors.length > 0) {
    throw new Error(`Invalid runtime config:\n- ${errors.join("\n- ")}`);
  }

  return {
    bundle,
    runtime: normalizedRuntime,
    runtimeSource: runtimeInput.source,
    runtimePath,
    node,
  };
}

function normalizeRuntime(runtime) {
  if (!runtime.node) {
    return runtime;
  }

  return {
    project: runtime.project,
    nodes: [runtime.node, ...(Array.isArray(runtime.peers) ? runtime.peers : [])],
    countries: runtime.countries ?? [],
    exitPools: runtime.exitPools ?? [],
    example: runtime.example ?? { enabled: false },
  };
}

async function generateConfig(context, args) {
  const outDir = resolveBundlePath(args.outDir);
  await mkdir(outDir, { recursive: true });
  await mkdir(resolveBundlePath("logs"), { recursive: true });

  const runtimeGenerated = renderRuntimeGenerated(context.runtime);
  const nodeGenerated = renderNodeConfig(context);
  const routing = renderRoutingConfig(context.runtime, context.node);
  const subscription = renderSubscriptionConfig(context.runtime, context.node);
  const xray = renderXrayConfig(context.runtime, context.node);
  const edge = renderEdgeConfig(context.runtime, context.node);

  await writeJson(path.join(outDir, "node.generated.json"), nodeGenerated);
  await writeJson(path.join(outDir, "runtime.generated.json"), runtimeGenerated);
  await writeJson(path.join(outDir, "routing.generated.json"), routing);
  await writeJson(path.join(outDir, "subscription.generated.json"), subscription);
  await writeJson(path.join(outDir, "xray.generated.json"), xray);
  if (edge.enabled) {
    await writeFile(path.join(outDir, "haproxy.generated.cfg"), edge.haproxy, "utf8");
    await writeFile(path.join(outDir, "Caddyfile.generated"), edge.caddyfile, "utf8");
  } else {
    await rm(path.join(outDir, "haproxy.generated.cfg"), { force: true });
    await rm(path.join(outDir, "Caddyfile.generated"), { force: true });
  }
  await writeJson(path.join(outDir, "image-manifest.generated.json"), renderImageManifest(context));
  await writeFile(path.join(outDir, "services.env"), renderServicesEnv(context), "utf8");
  await writeFile(path.join(outDir, "secrets.env"), renderSecretsEnv(), "utf8");
  await writeFile(path.join(outDir, "example-notes.txt"), renderExampleNotes(context, subscription), "utf8");
  await renderPublicSubscription(subscription);
}

function renderNodeConfig(context) {
  const { bundle, node, runtime } = context;
  return {
    project: runtime.project,
    node: {
      id: node.id,
      role: node.role,
      country: node.country,
      host: node.host,
      stable: node.stable,
      reality: node.reality,
      native: node.native,
      health: node.health,
      subscription: node.subscription ?? { enabled: false },
      edge: renderNodeEdgeMetadata(runtime, node),
    },
    target: {
      id: bundle.targetId,
      kind: bundle.bundleKind,
      platform: bundle.targetPlatform,
    },
    bundle: {
      version: bundle.bundleVersion,
      createdAt: bundle.createdAt,
    },
  };
}

function renderImageManifest(context) {
  return {
    note: "Use builder --save-images to include these runtime images in images/*.tar for Docker-only VPS deployment.",
    target: context.bundle.targetId,
    images: context.bundle.images,
  };
}

function renderServicesEnv(context) {
  const { bundle, node, runtime } = context;
  return [
    "# Generated service environment for the node bundle.",
    `PROJECT_NAME=${shellEnv(runtime.project.name)}`,
    `NODE_ID=${shellEnv(node.id)}`,
    `NODE_ROLE=${shellEnv(node.role)}`,
    `NODE_HOST=${shellEnv(node.host)}`,
    `TARGET_PLATFORM=${shellEnv(bundle.targetPlatform)}`,
    `SUBSCRIPTION_BASE_URL=${shellEnv(runtime.project.subscriptionBaseUrl)}`,
    "",
  ].join("\n");
}

function renderSecretsEnv() {
  return [
    "# Generated placeholder secrets file.",
    "# Real private keys, passwords, and UUID rotations must not be committed.",
    "# Repository examples use public placeholder values only.",
    "",
  ].join("\n");
}

function renderExampleNotes(context, subscription) {
  const { bundle, node, runtime } = context;
  const lines = [
    "Two-hop VPN node bundle",
    "",
    `Project: ${runtime.project.name}`,
    `Target: ${bundle.targetId}`,
    `Node: ${node.id}`,
    `Role: ${node.role}`,
    `Platform: ${bundle.targetPlatform}`,
    "",
    "This bundle contains generated Xray Stable runtime config for manual deployment.",
    "Runtime config may still contain placeholders until you customize it for live VPS hosts.",
  ];

  if (subscription.enabled) {
    lines.push("", `Example subscription URL: ${subscription.subscriptionUrl}`);
  }

  return `${lines.join("\n")}\n`;
}

function shellEnv(value) {
  return String(value).replaceAll("\n", "");
}

function resolveBundlePath(input) {
  if (path.isAbsolute(input)) {
    return input;
  }
  return path.join(bundleRoot, input);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function readJsonc(filePath) {
  const source = await readFile(filePath, "utf8");
  const json = stripTrailingCommas(stripJsonComments(source));
  return {
    source,
    value: JSON.parse(json),
  };
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }

    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      inString = true;
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(source) {
  return source.replace(/,\s*([}\]])/g, "$1");
}

function validateRuntime(runtime, bundle) {
  const errors = [];
  const project = requiredObject(runtime.project, "project", errors);
  requiredString(project.name, "project.name", errors);
  requiredString(project.subscriptionBaseUrl, "project.subscriptionBaseUrl", errors);

  const nodes = mapById(requiredArray(runtime.nodes, "nodes", errors), "nodes", errors);
  const countries = mapByKey(requiredArray(runtime.countries, "countries", errors), "code", "countries", errors);
  const exitPools = mapById(requiredArray(runtime.exitPools, "exitPools", errors), "exitPools", errors);

  for (const node of nodes.values()) {
    validateNode(node, node.id === bundle.nodeId, errors);
  }
  for (const country of countries.values()) {
    validateCountry(country, exitPools, errors);
  }
  for (const pool of exitPools.values()) {
    validateExitPool(pool, nodes, countries, errors);
  }
  validateExample(runtime.example, nodes, countries, exitPools, bundle, errors);
  validateEdge(runtime, bundle, errors);

  return errors;
}

function requiredObject(value, pathName, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${pathName} must be an object`);
    return {};
  }
  return value;
}

function requiredString(value, pathName, errors) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${pathName} must be a non-empty string`);
  }
}

function requiredArray(value, pathName, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${pathName} must be an array`);
    return [];
  }
  return value;
}

function mapById(items, pathName, errors) {
  return mapByKey(items, "id", pathName, errors);
}

function mapByKey(items, key, pathName, errors) {
  const map = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") {
      errors.push(`${pathName} entries must be objects`);
      continue;
    }
    if (typeof item[key] !== "string" || item[key].length === 0) {
      errors.push(`${pathName} entry is missing string ${key}`);
      continue;
    }
    if (map.has(item[key])) {
      errors.push(`${pathName} has duplicate ${key}: ${item[key]}`);
      continue;
    }
    map.set(item[key], item);
  }
  return map;
}

function validateNode(node, requirePrivateKey, errors) {
  if (!["rf-entry", "foreign-exit"].includes(node.role)) {
    errors.push(`node ${node.id} has unsupported role ${node.role}`);
  }
  requiredString(node.host, `node ${node.id}.host`, errors);
  validateCapability(node.stable, `node ${node.id}.stable`, true, errors);
  if (node.stable?.enabled) {
    validateReality(node.reality, `node ${node.id}.reality`, requirePrivateKey, errors);
  }
  validateCapability(node.native, `node ${node.id}.native`, false, errors);
  validateCapability(node.health, `node ${node.id}.health`, false, errors);
  if (node.subscription !== undefined) {
    validateCapability(node.subscription, `node ${node.id}.subscription`, false, errors);
  }
}

function validateCapability(capability, pathName, requirePortWhenEnabled, errors) {
  if (!capability || typeof capability !== "object") {
    errors.push(`${pathName} must be an object`);
    return;
  }
  if (typeof capability.enabled !== "boolean") {
    errors.push(`${pathName}.enabled must be boolean`);
  }
  if (capability.enabled && requirePortWhenEnabled && !isValidPort(capability.port)) {
    errors.push(`${pathName}.port must be a valid port when enabled`);
  }
}

function validateReality(reality, pathName, requirePrivateKey, errors) {
  if (!reality || typeof reality !== "object") {
    errors.push(`${pathName} must be an object when stable is enabled`);
    return;
  }
  requiredString(reality.target, `${pathName}.target`, errors);
  requiredArray(reality.serverNames, `${pathName}.serverNames`, errors);
  if (requirePrivateKey) {
    requiredString(reality.privateKey, `${pathName}.privateKey`, errors);
  }
  requiredString(reality.publicKey, `${pathName}.publicKey`, errors);
  requiredArray(reality.shortIds, `${pathName}.shortIds`, errors);
  requiredString(reality.fingerprint, `${pathName}.fingerprint`, errors);
  requiredString(reality.spiderX, `${pathName}.spiderX`, errors);
}

function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function validateCountry(country, exitPools, errors) {
  requiredString(country.name, `country ${country.code}.name`, errors);
  if (!exitPools.has(country.exitPool)) {
    errors.push(`country ${country.code} references missing exitPool ${country.exitPool}`);
  }
}

function validateExitPool(pool, nodes, countries, errors) {
  if (!countries.has(pool.country)) {
    errors.push(`exitPool ${pool.id} references missing country ${pool.country}`);
  }
  for (const nodeId of requiredArray(pool.nodes, `exitPool ${pool.id}.nodes`, errors)) {
    const node = nodes.get(nodeId);
    if (!node) {
      errors.push(`exitPool ${pool.id} references missing node ${nodeId}`);
    } else if (node.role !== "foreign-exit") {
      errors.push(`exitPool ${pool.id} references non-exit node ${nodeId}`);
    }
  }
}

function validateExample(example, nodes, countries, exitPools, bundle, errors) {
  if (!example?.enabled) {
    return;
  }
  const profiles = requiredArray(example.profiles, "example.profiles", errors);
  const needsSubscriptionFields = bundle.nodeRole === "rf-entry" && profiles.some((profile) => profile.entryNode === bundle.nodeId);

  if (needsSubscriptionFields) {
    const user = requiredObject(example.user, "example.user", errors);
    requiredString(user.id, "example.user.id", errors);
    requiredString(user.subscriptionToken, "example.user.subscriptionToken", errors);
    const reality = requiredObject(example.reality, "example.reality", errors);
    requiredString(reality.sni, "example.reality.sni", errors);
    requiredString(reality.publicKey, "example.reality.publicKey", errors);
    requiredString(reality.shortId, "example.reality.shortId", errors);
  }

  for (const profile of profiles) {
    if (profile.entryNode === bundle.nodeId && !nodes.has(profile.entryNode)) {
      errors.push(`example.profile ${profile.id} references missing entryNode ${profile.entryNode}`);
    }
    if (!countries.has(profile.country)) {
      errors.push(`example.profile ${profile.id} references missing country ${profile.country}`);
    }
    if (!exitPools.has(profile.exitPool)) {
      errors.push(`example.profile ${profile.id} references missing exitPool ${profile.exitPool}`);
    }
  }
}

function validateEdge(runtime, bundle, errors) {
  const node = runtime.nodes.find((candidate) => candidate.id === bundle.nodeId);
  if (!node || node.role !== "rf-entry" || !node.subscription?.enabled) {
    return;
  }

  const subscriptionUrl = parseUrl(runtime.project.subscriptionBaseUrl);
  if (!subscriptionUrl) {
    errors.push("project.subscriptionBaseUrl must be a valid URL");
    return;
  }
  if (subscriptionUrl.protocol !== "https:") {
    errors.push("project.subscriptionBaseUrl must use https:// when RF edge is enabled");
  }
  if (subscriptionUrl.port) {
    errors.push("project.subscriptionBaseUrl must not include a port when RF edge is enabled");
  }
  if (subscriptionUrl.hostname === node.host) {
    errors.push("project.subscriptionBaseUrl hostname must differ from node.host so HAProxy can route subscription and Reality by SNI");
  }
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function renderRuntimeGenerated(runtime) {
  return {
    project: runtime.project,
    nodes: runtime.nodes,
    countries: runtime.countries,
    exitPools: runtime.exitPools,
    example: runtime.example,
  };
}

function renderRoutingConfig(runtime, node) {
  return {
    countries: runtime.countries,
    exitPools: runtime.exitPools,
    profiles: runtime.example?.enabled
      ? runtime.example.profiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          country: profile.country,
          mode: profile.mode,
          strictCountry: profile.mode !== "auto",
          entryNode: profile.entryNode,
          exitPool: profile.exitPool,
          visibleOnNode: node.id === profile.entryNode || runtime.exitPools.find((pool) => pool.id === profile.exitPool)?.nodes.includes(node.id),
        }))
      : [],
  };
}

function renderSubscriptionConfig(runtime, node) {
  if (!runtime.example?.enabled || node.role !== "rf-entry") {
    return {
      enabled: false,
      reason: node.role === "rf-entry" ? "example profiles disabled" : "subscription output is emitted by rf-entry bundles",
    };
  }
  const token = runtime.example.user.subscriptionToken;
  return {
    enabled: true,
    user: {
      id: runtime.example.user.id,
      plan: runtime.example.user.plan,
    },
    token,
    subscriptionUrl: `${runtime.project.subscriptionBaseUrl.replace(/\/$/, "")}/sub/${encodeURIComponent(token)}`,
    formats: ["raw-share-links"],
    profiles: runtime.example.profiles
      .filter((profile) => profile.entryNode === node.id)
      .map((profile) => ({
        id: profile.id,
        name: profile.name,
        country: profile.country,
        mode: profile.mode,
        strictCountry: profile.mode !== "auto",
        rawLink: renderVlessLink(runtime, node, profile),
      })),
  };
}

function renderVlessLink(runtime, node, profile) {
  const reality = runtime.example.reality;
  const params = new URLSearchParams({
    type: "tcp",
    security: "reality",
    encryption: "none",
    flow: "xtls-rprx-vision",
    sni: reality.sni,
    fp: reality.fingerprint,
    pbk: reality.publicKey,
    sid: reality.shortId,
  });
  return `vless://${profile.uuid}@${node.host}:${node.stable.port}?${params.toString()}#${encodeURIComponent(profile.name)}`;
}

function renderNodeEdgeMetadata(runtime, node) {
  const edge = renderEdgeConfig(runtime, node);
  if (!edge.enabled) {
    return { enabled: false };
  }
  return {
    enabled: true,
    publicHttpPort: edgePorts.http,
    publicTlsPort: edgePorts.tls,
    subscriptionHost: edge.subscriptionHost,
    realityHost: node.host,
    xrayStableBackendPort: edgePorts.xrayStableBackend,
    caddyHttpPort: edgePorts.caddyHttp,
    caddyHttpsPort: edgePorts.caddyHttps,
  };
}

function renderEdgeConfig(runtime, node) {
  if (node.role !== "rf-entry" || !node.subscription?.enabled) {
    return { enabled: false };
  }

  const subscriptionUrl = new URL(runtime.project.subscriptionBaseUrl);
  const subscriptionHost = subscriptionUrl.hostname;
  return {
    enabled: true,
    subscriptionHost,
    haproxy: renderHaproxyConfig(subscriptionHost),
    caddyfile: renderCaddyfile(subscriptionHost, node.subscription.port),
  };
}

function renderHaproxyConfig(subscriptionHost) {
  return [
    "global",
    "  log stdout format raw local0",
    "",
    "defaults",
    "  log global",
    "  timeout connect 5s",
    "  timeout client 1m",
    "  timeout server 1m",
    "",
    "frontend http_in",
    `  bind *:${edgePorts.http}`,
    "  mode http",
    "  option httplog",
    `  acl subscription_host hdr(host) -i ${subscriptionHost}`,
    "  use_backend caddy_http if subscription_host",
    "  default_backend caddy_http",
    "",
    "backend caddy_http",
    "  mode http",
    `  server caddy caddy:${edgePorts.caddyHttp}`,
    "",
    "frontend tls_in",
    `  bind *:${edgePorts.tls}`,
    "  mode tcp",
    "  option tcplog",
    "  tcp-request inspect-delay 5s",
    "  tcp-request content accept if { req_ssl_hello_type 1 }",
    `  acl subscription_sni req.ssl_sni -i ${subscriptionHost}`,
    "  use_backend caddy_tls if subscription_sni",
    "  default_backend xray_tls",
    "",
    "backend caddy_tls",
    "  mode tcp",
    `  server caddy caddy:${edgePorts.caddyHttps}`,
    "",
    "backend xray_tls",
    "  mode tcp",
    `  server xray xray:${edgePorts.xrayStableBackend}`,
    "",
  ].join("\n");
}

function renderCaddyfile(subscriptionHost, subscriptionPort) {
  return [
    "{",
    `  http_port ${edgePorts.caddyHttp}`,
    `  https_port ${edgePorts.caddyHttps}`,
    "}",
    "",
    `${subscriptionHost} {`,
    `  reverse_proxy subscription:${subscriptionPort}`,
    "}",
    "",
  ].join("\n");
}

function renderXrayConfig(runtime, node) {
  return node.role === "rf-entry" ? renderRfEntryXrayConfig(runtime, node) : renderForeignExitXrayConfig(runtime, node);
}

function renderRfEntryXrayConfig(runtime, node) {
  const profiles = runtime.example?.enabled ? runtime.example.profiles.filter((profile) => profile.entryNode === node.id && profile.mode === "stable") : [];
  const outbounds = [];
  const rules = [];
  for (const profile of profiles) {
    const exitNode = firstExitNodeForProfile(runtime, profile);
    const outboundTag = `stable-${profile.country.toLowerCase()}-${exitNode.id}`;
    outbounds.push(renderVlessRealityOutbound(outboundTag, exitNode, profile));
    rules.push({ type: "field", user: [profileEmail(profile)], outboundTag });
  }
  outbounds.push({ tag: "blocked", protocol: "blackhole", settings: {} });
  return {
    log: { loglevel: "warning" },
    inbounds: [renderVlessRealityInbound("client-stable-in", node, profiles)],
    outbounds,
    routing: { domainStrategy: "AsIs", rules },
  };
}

function renderForeignExitXrayConfig(runtime, node) {
  const profiles = runtime.example?.enabled
    ? runtime.example.profiles.filter((profile) => profile.mode === "stable" && runtime.exitPools.find((pool) => pool.id === profile.exitPool)?.nodes.includes(node.id))
    : [];
  return {
    log: { loglevel: "warning" },
    inbounds: [renderVlessRealityInbound("rf-stable-in", node, profiles)],
    outbounds: [
      { tag: "direct", protocol: "freedom", settings: {} },
      { tag: "blocked", protocol: "blackhole", settings: {} },
    ],
    routing: { domainStrategy: "AsIs", rules: [] },
  };
}

function renderVlessRealityInbound(tag, node, profiles) {
  return {
    tag,
    listen: "0.0.0.0",
    port: xrayStableListenPort(node),
    protocol: "vless",
    settings: {
      clients: profiles.map((profile) => ({
        id: profile.uuid,
        email: profileEmail(profile),
        flow: "xtls-rprx-vision",
      })),
      decryption: "none",
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        show: false,
        target: node.reality.target,
        dest: node.reality.target,
        xver: 0,
        serverNames: node.reality.serverNames,
        privateKey: node.reality.privateKey,
        shortIds: node.reality.shortIds,
      },
    },
    sniffing: {
      enabled: true,
      destOverride: ["http", "tls", "quic"],
    },
  };
}

function xrayStableListenPort(node) {
  return node.role === "rf-entry" && node.subscription?.enabled ? edgePorts.xrayStableBackend : node.stable.port;
}

function renderVlessRealityOutbound(tag, exitNode, profile) {
  return {
    tag,
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: exitNode.host,
          port: exitNode.stable.port,
          users: [
            {
              id: profile.uuid,
              email: profileEmail(profile),
              encryption: "none",
              flow: "xtls-rprx-vision",
            },
          ],
        },
      ],
    },
    streamSettings: {
      network: "tcp",
      security: "reality",
      realitySettings: {
        serverName: exitNode.reality.serverNames[0],
        fingerprint: exitNode.reality.fingerprint,
        publicKey: exitNode.reality.publicKey,
        password: exitNode.reality.publicKey,
        shortId: exitNode.reality.shortIds[0],
        spiderX: exitNode.reality.spiderX,
      },
    },
  };
}

function firstExitNodeForProfile(runtime, profile) {
  const pool = runtime.exitPools.find((candidate) => candidate.id === profile.exitPool);
  const nodeId = pool.nodes.find((candidate) => runtime.nodes.find((node) => node.id === candidate)?.stable?.enabled);
  return runtime.nodes.find((node) => node.id === nodeId);
}

function profileEmail(profile) {
  return `${profile.id}@${profile.entryNode}`;
}

async function renderPublicSubscription(subscription) {
  await rm(path.join(bundleRoot, "public", "sub"), { recursive: true, force: true });
  if (!subscription.enabled) {
    return;
  }
  const subDir = path.join(bundleRoot, "public", "sub");
  await mkdir(subDir, { recursive: true });
  const body = `${subscription.profiles.map((profile) => profile.rawLink).join("\n")}\n`;
  await writeFile(path.join(subDir, subscription.token), body, "utf8");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
