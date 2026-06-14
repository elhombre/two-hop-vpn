#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const allowedRoles = new Set(["rf-entry", "foreign-exit"]);
const allowedKinds = new Set(["node"]);
const allowedModes = new Set(["stable", "native", "auto"]);
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
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!args.buildConfig) {
    throw new Error("Missing --build-config <path>");
  }

  const outDir = path.resolve(repoRoot, args.outDir ?? "dist");
  const archive = args.archive !== false;
  const saveImages = args.saveImages === true;
  const selectedPlatforms = args.targetPlatforms.length > 0 ? args.targetPlatforms : undefined;

  const loaded = await loadConfigInputs(args);
  const plan = await resolvePlan(loaded.config, selectedPlatforms);

  await mkdir(outDir, { recursive: true });
  const stageRoot = path.join(outDir, ".build");
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  const outputs = [];
  for (const target of plan.targets) {
    const bundleDir = path.join(stageRoot, target.id, "vpn-bundle");
    await renderBundle(plan, target, bundleDir, { saveImages });

    const archivePath = path.join(outDir, `${target.id}.tar.gz`);
    if (archive) {
      await createArchive(bundleDir, archivePath);
    }

    outputs.push({
      target: target.id,
      node: target.node.id,
      role: target.role,
      platform: target.platform,
      bundleDir,
      archive: archive ? archivePath : null,
    });
  }

  await writeJson(path.join(outDir, "build-plan.generated.json"), {
    project: plan.project,
    generatedAt: plan.createdAt,
    targetCount: outputs.length,
    outputs: outputs.map((output) => ({
      target: output.target,
      node: output.node,
      role: output.role,
      platform: output.platform,
      archive: output.archive ? path.relative(repoRoot, output.archive) : null,
      bundleDir: path.relative(repoRoot, output.bundleDir),
    })),
  });

  for (const output of outputs) {
    const archiveText = output.archive ? path.relative(repoRoot, output.archive) : "not archived";
    console.log(`${output.target}: ${archiveText}`);
  }
}

function parseArgs(argv) {
  const args = {
    targetPlatforms: [],
    archive: true,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--build-config":
        args.buildConfig = readValue(argv, ++index, arg);
        break;
      case "--target-platform":
        args.targetPlatforms.push(readValue(argv, ++index, arg));
        break;
      case "--out-dir":
        args.outDir = readValue(argv, ++index, arg);
        break;
      case "--no-archive":
        args.archive = false;
        break;
      case "--save-images":
        args.saveImages = true;
        break;
      case "-h":
      case "--help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
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
  console.log(`Usage: node scripts/build-bundles.mjs --build-config <path> [options]

Options:
  --build-config <path>       Build JSONC config path inside this repository.
  --target-platform <platform>  Build only this target platform. May be repeated.
  --out-dir <path>             Output directory inside this repository. Defaults to dist.
  --no-archive                 Render bundle directories without tar.gz archives.
  --save-images                Pull and save runtime Docker images into each bundle.
  -h, --help                   Show help.
`);
}

async function loadConfigInputs(args) {
  const buildConfigPath = path.resolve(repoRoot, args.buildConfig);
  const build = await readJsonc(buildConfigPath);

  return {
    config: build.value,
  };
}

async function readJsonc(filePath) {
  const source = await readFile(filePath, "utf8");
  const json = stripTrailingCommas(stripJsonComments(source));
  try {
    return {
      source,
      value: JSON.parse(json),
    };
  } catch (error) {
    throw new Error(`Failed to parse JSONC ${filePath}: ${error.message}`);
  }
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

async function resolvePlan(config, selectedPlatforms) {
  const errors = [];
  const build = optionalObject(config.build, "build", errors) ?? {};
  const bundleVersion = typeof build.bundleVersion === "number" ? build.bundleVersion : 1;
  const createdAt = typeof build.createdAt === "string" ? build.createdAt : new Date().toISOString();
  const images = validateImages(config.images, errors);

  const platforms = requiredArray(config.platforms, "platforms", errors);
  const selected = selectedPlatforms ?? platforms;
  for (const platform of selected) {
    if (!platforms.includes(platform)) {
      errors.push(`selected target platform ${platform} is not listed in platforms`);
    }
  }

  const rawTargets = requiredArray(config.targets, "targets", errors);

  const targets = [];
  const targetIds = new Set();
  for (const target of rawTargets) {
    validateTarget(target, platforms, errors);
    if (!target || typeof target !== "object") {
      continue;
    }
    if (!selected.includes(target.platform)) {
      continue;
    }
    if (typeof target.configFile !== "string" || target.configFile.length === 0) {
      continue;
    }

    const configPath = path.resolve(repoRoot, target.configFile);
    const loaded = await readJsonc(configPath);
    const runtime = normalizeRuntime(loaded.value);
    validateRuntimeConfig(runtime, target, errors);
    const role = target.role ?? runtime.node.role;
    const targetId = target.id ?? deriveTargetId(role, target.platform);
    if (targetIds.has(targetId)) {
      errors.push(`targets has duplicate derived id: ${targetId}`);
    }
    targetIds.add(targetId);

    targets.push({
      ...target,
      id: targetId,
      role,
      node: runtime.node,
      runtime,
      runtimeSource: loaded.source,
      runtimeSourcePath: path.relative(repoRoot, configPath),
    });
  }

  if (targets.length === 0) {
    errors.push("no targets selected");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid build config:\n- ${errors.join("\n- ")}`);
  }

  return {
    project: targets[0]?.runtime.project ?? { name: "two-hop-vpn", subscriptionBaseUrl: "" },
    images,
    bundleVersion,
    createdAt,
    platforms,
    selectedPlatforms: selected,
    targets,
  };
}

function deriveTargetId(role, platform) {
  return `${role}-${platform.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
}

function normalizeRuntime(runtime) {
  const node = requiredObject(runtime.node, "node", []);
  return {
    ...runtime,
    node,
    peers: Array.isArray(runtime.peers) ? runtime.peers : [],
    countries: Array.isArray(runtime.countries) ? runtime.countries : [],
    exitPools: Array.isArray(runtime.exitPools) ? runtime.exitPools : [],
    clientAccess: runtime.clientAccess,
  };
}

function validateRuntimeConfig(runtime, target, errors) {
  const prefix = `target config ${target.configFile}`;
  const project = requiredObject(runtime.project, `${prefix}.project`, errors);
  requiredString(project.name, `${prefix}.project.name`, errors);
  requiredString(project.subscriptionBaseUrl, `${prefix}.project.subscriptionBaseUrl`, errors);

  validateNode(runtime.node, `${prefix}.node`, true, errors);
  if (target.role !== undefined && runtime.node.role !== target.role) {
    errors.push(`target ${target.configFile} role ${target.role} does not match config node role ${runtime.node.role}`);
  }
  if (target.node !== undefined && runtime.node.id !== target.node) {
    errors.push(`target ${target.configFile} node ${target.node} does not match config node id ${runtime.node.id}`);
  }

  const nodes = mapById([runtime.node, ...runtime.peers], `${prefix}.nodes`, errors);
  const countries = mapByKey(runtime.countries, "code", `${prefix}.countries`, errors);
  const exitPools = mapById(runtime.exitPools, `${prefix}.exitPools`, errors);

  for (const peer of runtime.peers) {
    validateNode(peer, `${prefix}.peer ${peer.id}`, false, errors);
  }
  for (const country of countries.values()) {
    validateCountry(country, exitPools, errors);
  }
  for (const pool of exitPools.values()) {
    validateExitPool(pool, nodes, countries, errors);
  }
  validateClientAccess(runtime.clientAccess, nodes, countries, exitPools, runtime.node, errors);
  validateEdge(runtime, errors);
}

function validateEdge(runtime, errors) {
  const node = runtime.node;
  if (node.role !== "rf-entry" || !node.subscription?.enabled) {
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

function requiredObject(value, pathName, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${pathName} must be an object`);
    return {};
  }
  return value;
}

function optionalObject(value, pathName, errors) {
  if (value === undefined) {
    return undefined;
  }
  return requiredObject(value, pathName, errors);
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

function validateImages(images, errors) {
  const value = optionalObject(images, "images", errors) ?? {};
  const xray = value.xray ?? "ghcr.io/xtls/xray-core:latest";
  const busybox = value.busybox ?? "busybox:1.36.1";
  const node = value.node ?? "node:22-alpine";
  const haproxy = value.haproxy ?? "haproxy:2.9-alpine";
  const caddy = value.caddy ?? "caddy:2.8-alpine";
  requiredString(xray, "images.xray", errors);
  requiredString(busybox, "images.busybox", errors);
  requiredString(node, "images.node", errors);
  requiredString(haproxy, "images.haproxy", errors);
  requiredString(caddy, "images.caddy", errors);
  return { xray, busybox, node, haproxy, caddy };
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

function validateNode(node, pathName, requirePrivateKey, errors) {
  if (!allowedRoles.has(node.role)) {
    errors.push(`${pathName} has unsupported role ${node.role}`);
  }
  requiredString(node.id, `${pathName}.id`, errors);
  requiredString(node.host, `${pathName}.host`, errors);
  requiredString(node.country, `${pathName}.country`, errors);
  validateCapability(node.stable, `${pathName}.stable`, true, errors);
  if (node.stable?.enabled) {
    validateReality(node.reality, `${pathName}.reality`, requirePrivateKey, errors);
  }
  validateCapability(node.native, `${pathName}.native`, false, errors);
  validateCapability(node.health, `${pathName}.health`, false, errors);
  if (node.subscription !== undefined) {
    validateCapability(node.subscription, `${pathName}.subscription`, false, errors);
  }
  validatePortConflicts(node, errors);
}

function validateReality(reality, pathName, requirePrivateKey, errors) {
  if (!reality || typeof reality !== "object" || Array.isArray(reality)) {
    errors.push(`${pathName} must be an object when stable is enabled`);
    return;
  }
  requiredString(reality.target, `${pathName}.target`, errors);
  requiredArray(reality.serverNames, `${pathName}.serverNames`, errors);
  if (Array.isArray(reality.serverNames) && reality.serverNames.length === 0) {
    errors.push(`${pathName}.serverNames must not be empty`);
  }
  if (requirePrivateKey) {
    requiredString(reality.privateKey, `${pathName}.privateKey`, errors);
  }
  requiredString(reality.publicKey, `${pathName}.publicKey`, errors);
  requiredArray(reality.shortIds, `${pathName}.shortIds`, errors);
  if (Array.isArray(reality.shortIds) && reality.shortIds.length === 0) {
    errors.push(`${pathName}.shortIds must not be empty`);
  }
  requiredString(reality.fingerprint, `${pathName}.fingerprint`, errors);
  requiredString(reality.spiderX, `${pathName}.spiderX`, errors);
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
    errors.push(`${pathName}.port must be a valid TCP/UDP port when enabled`);
  }
  if (capability.port !== undefined && !isValidPort(capability.port)) {
    errors.push(`${pathName}.port must be a valid port`);
  }
}

function validatePortConflicts(node, errors) {
  const used = new Map();
  for (const key of ["stable", "native", "health", "subscription"]) {
    const capability = node[key];
    if (!capability?.enabled || capability.port === undefined) {
      continue;
    }
    if (used.has(capability.port)) {
      errors.push(`node ${node.id} has port conflict: ${key} and ${used.get(capability.port)} both use ${capability.port}`);
    }
    used.set(capability.port, key);
  }
}

function isValidPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

function validateCountry(country, exitPools, errors) {
  requiredString(country.name, `country ${country.code}.name`, errors);
  if (typeof country.stableEnabled !== "boolean") {
    errors.push(`country ${country.code}.stableEnabled must be boolean`);
  }
  if (typeof country.nativeEnabled !== "boolean") {
    errors.push(`country ${country.code}.nativeEnabled must be boolean`);
  }
  if (!exitPools.has(country.exitPool)) {
    errors.push(`country ${country.code} references missing exitPool ${country.exitPool}`);
  }
}

function validateExitPool(pool, nodes, countries, errors) {
  if (!countries.has(pool.country)) {
    errors.push(`exitPool ${pool.id} references missing country ${pool.country}`);
  }
  const poolNodes = requiredArray(pool.nodes, `exitPool ${pool.id}.nodes`, errors);
  for (const nodeId of poolNodes) {
    const node = nodes.get(nodeId);
    if (!node) {
      errors.push(`exitPool ${pool.id} references missing node ${nodeId}`);
      continue;
    }
    if (node.role !== "foreign-exit") {
      errors.push(`exitPool ${pool.id} references non-exit node ${nodeId}`);
    }
    if (node.country !== pool.country) {
      errors.push(`exitPool ${pool.id} node ${nodeId} country ${node.country} does not match pool country ${pool.country}`);
    }
  }
}

function validateTarget(target, platforms, errors) {
  if (!target || typeof target !== "object") {
    errors.push("targets entries must be objects");
    return;
  }
  if (target.id !== undefined) {
    requiredString(target.id, "target.id", errors);
  }
  if (target.role !== undefined && !allowedRoles.has(target.role)) {
    errors.push(`target role ${target.role} is unsupported`);
  }

  if (!allowedKinds.has(target.kind)) {
    errors.push(`target ${target.configFile ?? "<unknown>"} has unsupported kind ${target.kind}`);
  }
  if (!platforms.includes(target.platform)) {
    errors.push(`target ${target.configFile ?? "<unknown>"} platform ${target.platform} is not listed in platforms`);
  }
  requiredString(target.configFile, "target.configFile", errors);
}

function validateClientAccess(clientAccess, nodes, countries, exitPools, bundleNode, errors) {
  if (!clientAccess || typeof clientAccess !== "object" || Array.isArray(clientAccess)) {
    errors.push("clientAccess must be an object");
    return;
  }

  if (clientAccess.enabled !== true) {
    errors.push("clientAccess.enabled must be true");
  }

  const profiles = requiredArray(clientAccess.profiles, "clientAccess.profiles", errors);
  if (profiles.length === 0) {
    errors.push("clientAccess.profiles must not be empty");
  }
  const needsSubscriptionFields = bundleNode.role === "rf-entry" && profiles.some((profile) => profile.entryNode === bundleNode.id);
  if (needsSubscriptionFields) {
    const user = requiredObject(clientAccess.user, "clientAccess.user", errors);
    requiredString(user.id, "clientAccess.user.id", errors);
    requiredString(user.plan, "clientAccess.user.plan", errors);
    requiredString(user.subscriptionToken, "clientAccess.user.subscriptionToken", errors);

    const reality = requiredObject(clientAccess.reality, "clientAccess.reality", errors);
    requiredString(reality.sni, "clientAccess.reality.sni", errors);
    requiredString(reality.fingerprint, "clientAccess.reality.fingerprint", errors);
    requiredString(reality.publicKey, "clientAccess.reality.publicKey", errors);
    requiredString(reality.shortId, "clientAccess.reality.shortId", errors);
  }
  validateClientAccessTransport(clientAccess.transport, errors);

  const profileIds = new Set();
  for (const profile of profiles) {
    validateClientAccessProfile(profile, nodes, countries, exitPools, bundleNode, profileIds, errors);
  }

}

function validateClientAccessProfile(profile, nodes, countries, exitPools, bundleNode, profileIds, errors) {
  if (!profile || typeof profile !== "object") {
    errors.push("clientAccess.profiles entries must be objects");
    return;
  }

  requiredString(profile.id, "clientAccess.profile.id", errors);
  if (profileIds.has(profile.id)) {
    errors.push(`clientAccess.profiles has duplicate id: ${profile.id}`);
  }
  profileIds.add(profile.id);

  requiredString(profile.name, `clientAccess.profile ${profile.id}.name`, errors);
  if (!allowedModes.has(profile.mode)) {
    errors.push(`clientAccess.profile ${profile.id} has unsupported mode ${profile.mode}`);
  }
  if (!countries.has(profile.country)) {
    errors.push(`clientAccess.profile ${profile.id} references missing country ${profile.country}`);
  }
  const entryNode = nodes.get(profile.entryNode);
  if (!entryNode && profile.entryNode === bundleNode.id) {
    errors.push(`clientAccess.profile ${profile.id} references missing entryNode ${profile.entryNode}`);
  } else if (entryNode && entryNode.role !== "rf-entry") {
    errors.push(`clientAccess.profile ${profile.id} entryNode ${profile.entryNode} is not rf-entry`);
  }
  const exitPool = exitPools.get(profile.exitPool);
  if (!exitPool) {
    errors.push(`clientAccess.profile ${profile.id} references missing exitPool ${profile.exitPool}`);
  } else if (exitPool.country !== profile.country) {
    errors.push(`clientAccess.profile ${profile.id} country ${profile.country} does not match exitPool ${profile.exitPool} country ${exitPool.country}`);
  }
  const country = countries.get(profile.country);
  if (profile.mode === "stable" && country && !country.stableEnabled) {
    errors.push(`clientAccess.profile ${profile.id} uses stable mode but country ${profile.country} has stableEnabled=false`);
  }
  if (profile.mode === "native" && country && !country.nativeEnabled) {
    errors.push(`clientAccess.profile ${profile.id} uses native mode but country ${profile.country} has nativeEnabled=false`);
  }
  if (profile.mode === "stable" && entryNode && !entryNode.stable?.enabled) {
    errors.push(`clientAccess.profile ${profile.id} uses stable mode but entryNode ${profile.entryNode} has stable.enabled=false`);
  }
  if (profile.mode === "native" && entryNode && !entryNode.native?.enabled) {
    errors.push(`clientAccess.profile ${profile.id} uses native mode but entryNode ${profile.entryNode} has native.enabled=false`);
  }
  if (profile.mode === "stable" && exitPool && !exitPool.nodes.some((nodeId) => nodes.get(nodeId)?.stable?.enabled)) {
    errors.push(`clientAccess.profile ${profile.id} uses stable mode but exitPool ${profile.exitPool} has no stable-enabled exit node`);
  }
  if (profile.exitNode !== undefined) {
    requiredString(profile.exitNode, `clientAccess.profile ${profile.id}.exitNode`, errors);
    const exitNode = nodes.get(profile.exitNode);
    if (!exitNode) {
      errors.push(`clientAccess.profile ${profile.id} references missing exitNode ${profile.exitNode}`);
    } else if (exitNode.role !== "foreign-exit") {
      errors.push(`clientAccess.profile ${profile.id} exitNode ${profile.exitNode} is not foreign-exit`);
    } else if (!exitNode.stable?.enabled) {
      errors.push(`clientAccess.profile ${profile.id} exitNode ${profile.exitNode} has stable.enabled=false`);
    } else if (exitPool && !exitPool.nodes.includes(profile.exitNode)) {
      errors.push(`clientAccess.profile ${profile.id} exitNode ${profile.exitNode} is not part of exitPool ${profile.exitPool}`);
    }
  }
  if (profile.mode === "native" && exitPool && !exitPool.nodes.some((nodeId) => nodes.get(nodeId)?.native?.enabled)) {
    errors.push(`clientAccess.profile ${profile.id} uses native mode but exitPool ${profile.exitPool} has no native-enabled exit node`);
  }
  if (profile.mode === "stable" && !isUuid(profile.uuid)) {
    errors.push(`clientAccess.profile ${profile.id}.uuid must be a UUID for stable mode`);
  }
}

function validateClientAccessTransport(transport, errors) {
  if (transport === undefined) {
    return;
  }
  if (!transport || typeof transport !== "object" || Array.isArray(transport)) {
    errors.push("clientAccess.transport must be an object");
    return;
  }
  validateFlow(transport.clientFlow, "clientAccess.transport.clientFlow", errors);
  validateFlow(transport.exitFlow, "clientAccess.transport.exitFlow", errors);
  if (transport.exitMux !== undefined) {
    if (!transport.exitMux || typeof transport.exitMux !== "object" || Array.isArray(transport.exitMux)) {
      errors.push("clientAccess.transport.exitMux must be an object");
    } else {
      if (typeof transport.exitMux.enabled !== "boolean") {
        errors.push("clientAccess.transport.exitMux.enabled must be boolean");
      }
      if (transport.exitMux.concurrency !== undefined && (!Number.isInteger(transport.exitMux.concurrency) || transport.exitMux.concurrency < 1 || transport.exitMux.concurrency > 1024)) {
        errors.push("clientAccess.transport.exitMux.concurrency must be an integer between 1 and 1024");
      }
    }
  }
}

function validateFlow(value, pathName, errors) {
  if (value === undefined) {
    return;
  }
  if (!["none", "xtls-rprx-vision"].includes(value)) {
    errors.push(`${pathName} must be one of: none, xtls-rprx-vision`);
  }
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function renderBundle(plan, target, bundleDir, options) {
  await mkdir(bundleDir, { recursive: true });
  await mkdir(path.join(bundleDir, "manage"), { recursive: true });

  const bundle = renderBundleMetadata(plan, target);
  const subscription = renderSubscriptionConfig(target);

  await writeJson(path.join(bundleDir, "bundle.json"), bundle);
  await writeFile(path.join(bundleDir, "docker-compose.yml"), renderCompose(plan, target), "utf8");
  await renderRuntimeConfigExample(target, bundleDir);
  await writeFile(path.join(bundleDir, "README.md"), renderBundleReadme(plan, target, subscription), "utf8");

  const manageTemplatePath = path.join(repoRoot, "templates", "manage.sh.template");
  const manageTemplate = await readFile(manageTemplatePath, "utf8");
  const manage = manageTemplate
    .replaceAll("__APP_NAME__", plan.project.name)
    .replaceAll("__NODE_ID__", target.node.id)
    .replaceAll("__NODE_ROLE__", target.role)
    .replaceAll("__MANAGE_IMAGE__", plan.images.node);
  const managePath = path.join(bundleDir, "manage.sh");
  await writeFile(managePath, manage, "utf8");
  await chmod(managePath, 0o755);

  const manageHelperPath = path.join(repoRoot, "templates", "manage.mjs");
  const manageHelper = await readFile(manageHelperPath, "utf8");
  await writeFile(path.join(bundleDir, "manage", "manage.mjs"), manageHelper, "utf8");

  if (options.saveImages) {
    await saveRuntimeImages(plan, target, bundleDir);
  }
}

function renderBundleMetadata(plan, target) {
  return {
    project: target.runtime.project.name,
    bundleVersion: plan.bundleVersion,
    bundleKind: "node",
    targetId: target.id,
    nodeId: target.node.id,
    nodeRole: target.role,
    targetPlatform: target.platform,
    createdAt: plan.createdAt,
    clientAccess: {
      enabled: target.runtime.clientAccess.enabled,
      bootstrapUserId: target.runtime.clientAccess.enabled && target.runtime.clientAccess.user ? target.runtime.clientAccess.user.id : null,
    },
    images: getRuntimeImages(plan, target).map((image) => ({
      name: image,
      file: `images/${imageFileName(image)}`,
    })),
  };
}

async function renderRuntimeConfigExample(target, bundleDir) {
  await writeFile(path.join(bundleDir, "example.config.jsonc"), renderRuntimeConfigExampleSource(target.runtimeSource), "utf8");
}

function renderRuntimeConfigExampleSource(source) {
  return [
    "// Copy this file to runtime.jsonc before first run:",
    "// cp example.config.jsonc runtime.jsonc",
    "// Then replace placeholder domains, Reality keys, short IDs, UUIDs, and tokens.",
    "// Do not commit real private keys or production secrets.",
    "",
    source,
  ].join("\n");
}

function renderSubscriptionConfig(target) {
  const runtime = target.runtime;
  if (!runtime.clientAccess.enabled || target.role !== "rf-entry" || !runtime.clientAccess.user) {
    return {
      enabled: false,
      reason: target.role === "rf-entry" ? "clientAccess profiles disabled" : "subscription output is emitted by rf-entry bundles",
    };
  }

  const token = runtime.clientAccess.user.subscriptionToken;
  const subscriptionUrl = `${runtime.project.subscriptionBaseUrl.replace(/\/$/, "")}/sub/${encodeURIComponent(token)}`;

  return {
    enabled: true,
    user: {
      id: runtime.clientAccess.user.id,
      plan: runtime.clientAccess.user.plan,
    },
    token,
    subscriptionUrl,
  };
}

function renderCompose(plan, target) {
  const project = target.runtime.project;
  const lines = [
    `name: ${yamlString(`${project.name}-${target.node.id}`)}`,
    "services:",
  ];

  if (target.role === "rf-entry" && target.node.subscription?.enabled) {
    lines.push(...renderRfEdgeComposeServices(plan, target, project));
  }

  lines.push(...renderXrayComposeService(plan, target, project));

  if (target.role === "rf-entry" && target.node.subscription?.enabled) {
    lines.push(
      "  subscription:",
      `    image: ${yamlString(plan.images.busybox)}`,
      "    command:",
      `      - ${yamlString("httpd")}`,
      `      - ${yamlString("-f")}`,
      `      - ${yamlString("-p")}`,
      `      - ${yamlString(String(target.node.subscription.port))}`,
      `      - ${yamlString("-h")}`,
      `      - ${yamlString("/www")}`,
      "    restart: unless-stopped",
      "    volumes:",
      `      - ${yamlString("./public:/www:ro")}`,
      "    expose:",
      `      - ${yamlString(String(target.node.subscription.port))}`,
      "    labels:",
      `      two-hop-vpn.project: ${yamlString(project.name)}`,
      `      two-hop-vpn.node-id: ${yamlString(target.node.id)}`,
      `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
    );
  }

  if (target.role === "rf-entry" && target.node.subscription?.enabled) {
    lines.push(
      "volumes:",
      "  caddy_data:",
      "  caddy_config:",
    );
  }

  lines.push("");
  return lines.join("\n");
}

function renderRfEdgeComposeServices(plan, target, project) {
  return [
    "  edge:",
    `    image: ${yamlString(plan.images.haproxy)}`,
    "    command:",
    `      - ${yamlString("haproxy")}`,
    `      - ${yamlString("-f")}`,
    `      - ${yamlString("/usr/local/etc/haproxy/haproxy.cfg")}`,
    "    restart: unless-stopped",
    "    depends_on:",
    "      - xray",
    "      - caddy",
    "    volumes:",
    `      - ${yamlString("./config/haproxy.generated.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro")}`,
    "    ports:",
    `      - ${yamlString(`${edgePorts.http}:${edgePorts.http}/tcp`)}`,
    `      - ${yamlString(`${edgePorts.tls}:${edgePorts.tls}/tcp`)}`,
    "    labels:",
    `      two-hop-vpn.project: ${yamlString(project.name)}`,
    `      two-hop-vpn.node-id: ${yamlString(target.node.id)}`,
    `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
    "      two-hop-vpn.edge: \"true\"",
    "  caddy:",
    `    image: ${yamlString(plan.images.caddy)}`,
    "    restart: unless-stopped",
    "    depends_on:",
    "      - subscription",
    "    volumes:",
    `      - ${yamlString("./config/Caddyfile.generated:/etc/caddy/Caddyfile:ro")}`,
    `      - ${yamlString("caddy_data:/data")}`,
    `      - ${yamlString("caddy_config:/config")}`,
    "    expose:",
    `      - ${yamlString(String(edgePorts.caddyHttp))}`,
    `      - ${yamlString(String(edgePorts.caddyHttps))}`,
    "    labels:",
    `      two-hop-vpn.project: ${yamlString(project.name)}`,
    `      two-hop-vpn.node-id: ${yamlString(target.node.id)}`,
    `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
  ];
}

function renderXrayComposeService(plan, target, project) {
  const lines = [
    "  xray:",
    `    image: ${yamlString(plan.images.xray)}`,
    "    command:",
    `      - ${yamlString("run")}`,
    `      - ${yamlString("-config")}`,
    `      - ${yamlString("/etc/xray/config.json")}`,
    "    restart: unless-stopped",
    "    volumes:",
    `      - ${yamlString("./config/xray.generated.json:/etc/xray/config.json:ro")}`,
    `      - ${yamlString("./logs:/bundle/logs")}`,
  ];

  if (target.role === "rf-entry" && target.node.subscription?.enabled) {
    lines.push("    expose:", `      - ${yamlString(String(edgePorts.xrayStableBackend))}`);
  } else {
    lines.push("    ports:", `      - ${yamlString(`${target.node.stable.port}:${target.node.stable.port}/tcp`)}`);
  }

  lines.push(
    "    labels:",
    `      two-hop-vpn.project: ${yamlString(project.name)}`,
    `      two-hop-vpn.node-id: ${yamlString(target.node.id)}`,
    `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
  );

  return lines;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function getRuntimeImages(plan, target) {
  const images = [plan.images.node, plan.images.xray];
  if (target.role === "rf-entry" && target.node.subscription?.enabled) {
    images.push(plan.images.haproxy, plan.images.caddy, plan.images.busybox);
  }
  return Array.from(new Set(images));
}

function imageFileName(image) {
  return `${image.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.tar`;
}

async function saveRuntimeImages(plan, target, bundleDir) {
  for (const image of getRuntimeImages(plan, target)) {
    const imagePath = path.join(bundleDir, "images", imageFileName(image));
    runCommand("docker", ["pull", image], `docker pull ${image}`);
    runCommand("docker", ["save", "-o", imagePath, image], `docker save ${image}`);
  }
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
}

function renderBundleReadme(plan, target, subscription) {
  const project = target.runtime.project;
  const lines = [
    `# ${project.name} ${target.node.id} bundle`,
    "",
    `Node: ${target.node.id}`,
    `Role: ${target.role}`,
    `Target: ${target.id}`,
    `Platform: ${target.platform}`,
    "",
    "## First run",
    "",
    "```sh",
    "./manage.sh doctor",
    "./manage.sh load",
    "cp example.config.jsonc runtime.jsonc",
    "./manage.sh validate",
    "./manage.sh generate-config",
    "./manage.sh up",
    "./manage.sh status",
    "```",
    "",
    "## Runtime config",
    "",
    "- `example.config.jsonc` is the bundled runtime config example.",
    "- Copy it to `runtime.jsonc`, then replace placeholders for the live VPS pair.",
    "- `config/runtime.generated.json`, `config/routing.generated.json`, and `config/xray.generated.json` are generated by `./manage.sh generate-config`.",
    "",
    "To regenerate runtime artifacts after editing the runtime JSONC:",
    "",
    "```sh",
    "./manage.sh generate-config",
    "./manage.sh restart",
    "```",
    "",
    "## Useful commands",
    "",
    "```sh",
    "./manage.sh config",
    "./manage.sh ps",
    "./manage.sh logs --tail=100",
    "./manage.sh logs -f",
    "./manage.sh down",
    "```",
  ];

  if (subscription.enabled) {
    const subscriptionHost = new URL(target.runtime.project.subscriptionBaseUrl).hostname;
    lines.push(
      "",
      "## Client access subscription",
      "",
      `Public URL configured in metadata: ${subscription.subscriptionUrl}`,
      "",
      "RF Entry publishes only 80/tcp and 443/tcp. Point both DNS records to this RF VPS IP:",
      "",
      "```text",
      `${target.node.host} -> RF VPS IP`,
      `${subscriptionHost} -> RF VPS IP`,
      "```",
      "",
      "Local file inside this bundle:",
      "",
      "```text",
      `public/sub/${subscription.token}`,
      "```",
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- `./manage.sh load` is implemented in shell and loads all `images/*.tar` files.",
    "- Docker operations such as `up`, `down`, `logs`, and `ps` are implemented in shell.",
    "- JSONC parsing, validation, and `generate-config` are delegated to the bundled Node.js manage helper image.",
    "",
  );

  return `${lines.join("\n")}`;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createArchive(bundleDir, archivePath) {
  await rm(archivePath, { force: true });
  const parent = path.dirname(bundleDir);
  const bundleName = path.basename(bundleDir);
  const result = spawnSync("tar", ["--no-xattrs", "-czf", archivePath, "-C", parent, bundleName], {
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
    stdio: "pipe",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`tar failed for ${archivePath}: ${result.stderr || result.stdout}`);
  }

  const archiveStat = await stat(archivePath);
  if (!archiveStat.isFile() || archiveStat.size === 0) {
    throw new Error(`tar did not create a valid archive at ${archivePath}`);
  }
}
