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
  const project = validateProject(config.project, errors);
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
    const role = target.role;
    const targetId = target.id ?? deriveTargetId(role, target.platform);
    if (targetIds.has(targetId)) {
      errors.push(`targets has duplicate derived id: ${targetId}`);
    }
    targetIds.add(targetId);

    targets.push({
      ...target,
      id: targetId,
      role,
    });
  }

  if (targets.length === 0) {
    errors.push("no targets selected");
  }

  if (errors.length > 0) {
    throw new Error(`Invalid build config:\n- ${errors.join("\n- ")}`);
  }

  return {
    project,
    images,
    bundleVersion,
    createdAt,
    platforms,
    selectedPlatforms: selected,
    targets,
  };
}

function validateProject(project, errors) {
  if (project === undefined) {
    return { name: "two-hop-vpn" };
  }
  const value = requiredObject(project, "project", errors);
  requiredString(value.name, "project.name", errors);
  return {
    name: typeof value.name === "string" && value.name.length > 0 ? value.name : "two-hop-vpn",
  };
}

function deriveTargetId(role, platform) {
  return `${role}-${platform.replace(/[^a-zA-Z0-9_.-]+/g, "-")}`;
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

function validateTarget(target, platforms, errors) {
  if (!target || typeof target !== "object") {
    errors.push("targets entries must be objects");
    return;
  }
  if (target.id !== undefined) {
    requiredString(target.id, "target.id", errors);
  }
  if (!allowedRoles.has(target.role)) {
    errors.push(`target role ${target.role} is unsupported`);
  }

  if (!allowedKinds.has(target.kind)) {
    errors.push(`target ${target.role ?? "<unknown>"} has unsupported kind ${target.kind}`);
  }
  if (!platforms.includes(target.platform)) {
    errors.push(`target ${target.role ?? "<unknown>"} platform ${target.platform} is not listed in platforms`);
  }
}

async function renderBundle(plan, target, bundleDir, options) {
  await mkdir(bundleDir, { recursive: true });
  await mkdir(path.join(bundleDir, "manage"), { recursive: true });

  const bundle = renderBundleMetadata(plan, target);

  await writeJson(path.join(bundleDir, "bundle.json"), bundle);
  await writeFile(path.join(bundleDir, "docker-compose.yml"), renderCompose(plan, target), "utf8");
  await renderRuntimeConfigExample(target, bundleDir);
  await writeFile(path.join(bundleDir, "README.md"), renderBundleReadme(plan, target), "utf8");

  const manageTemplatePath = path.join(repoRoot, "templates", "manage.sh.template");
  const manageTemplate = await readFile(manageTemplatePath, "utf8");
  const manage = manageTemplate
    .replaceAll("__APP_NAME__", plan.project.name)
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
    project: plan.project.name,
    bundleVersion: plan.bundleVersion,
    bundleKind: "node",
    targetId: target.id,
    nodeRole: target.role,
    targetPlatform: target.platform,
    createdAt: plan.createdAt,
    images: getRuntimeImages(plan, target).map((image) => ({
      name: image,
      file: `images/${imageFileName(image)}`,
    })),
  };
}

async function renderRuntimeConfigExample(target, bundleDir) {
  const examplePath = path.join(repoRoot, "config", "examples", target.role === "rf-entry" ? "rf-entry.config.jsonc" : "foreign-exit.config.jsonc");
  const source = await readFile(examplePath, "utf8");
  await writeFile(path.join(bundleDir, "example.config.jsonc"), renderRuntimeConfigExampleSource(source), "utf8");
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

function renderCompose(plan, target) {
  const project = plan.project;
  const lines = [
    `name: ${yamlString(`${project.name}-${target.role}`)}`,
    "services:",
  ];

  if (target.role === "rf-entry") {
    lines.push(...renderRfEdgeComposeServices(plan, target, project));
  }

  lines.push(...renderXrayComposeService(plan, target, project));

  if (target.role === "rf-entry") {
    lines.push(
      "  subscription:",
      `    image: ${yamlString(plan.images.busybox)}`,
      "    command:",
      `      - ${yamlString("httpd")}`,
      `      - ${yamlString("-f")}`,
      `      - ${yamlString("-p")}`,
      `      - ${yamlString("8081")}`,
      `      - ${yamlString("-h")}`,
      `      - ${yamlString("/www")}`,
      "    restart: unless-stopped",
      "    volumes:",
      `      - ${yamlString("./public:/www:ro")}`,
    "    expose:",
      `      - ${yamlString("8081")}`,
    "    labels:",
      `      two-hop-vpn.project: ${yamlString(project.name)}`,
      `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
    );
  }

  if (target.role === "rf-entry") {
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

  if (target.role === "rf-entry") {
    lines.push("    expose:", `      - ${yamlString(String(edgePorts.xrayStableBackend))}`);
  } else {
    lines.push("    ports:", `      - ${yamlString("443:443/tcp")}`);
  }

  lines.push(
    "    labels:",
    `      two-hop-vpn.project: ${yamlString(project.name)}`,
    `      two-hop-vpn.node-role: ${yamlString(target.role)}`,
  );

  return lines;
}

function yamlString(value) {
  return JSON.stringify(value);
}

function getRuntimeImages(plan, target) {
  const images = [plan.images.node, plan.images.xray];
  if (target.role === "rf-entry") {
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

function renderBundleReadme(plan, target) {
  const project = plan.project;
  const lines = [
    `# ${project.name} ${target.role} bundle`,
    "",
    `Role: ${target.role}`,
    `Target: ${target.id}`,
    `Platform: ${target.platform}`,
    "",
    "## First run",
    "",
    "Prepare the runtime config, then generate configs and start the stack:",
    "",
    "```sh",
    "cp example.config.jsonc runtime.jsonc",
    "vi runtime.jsonc",
    "./manage.sh generate-config",
    "./manage.sh up",
    "```",
    "",
    "If this bundle was built with saved Docker images, run `./manage.sh load` before `./manage.sh up`.",
    "`./manage.sh doctor`, `./manage.sh validate`, and `./manage.sh status` are useful checks, but they are not required to start the stack.",
    "",
    "## Runtime config",
    "",
    "- `example.config.jsonc` is a generic runtime config example for this role.",
    "- Copy it to `runtime.jsonc`, then replace placeholders for the live VPS.",
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

  if (target.role === "rf-entry") {
    lines.push(
      "",
      "## Client access subscription",
      "",
      "The public subscription URL is generated from `project.subscriptionBaseUrl` and each enabled `clientAccess.users[].subscriptionToken` in `runtime.jsonc`:",
      "",
      "```text",
      "<project.subscriptionBaseUrl>/sub/<clientAccess.users[].subscriptionToken>",
      "```",
      "",
      "RF Entry publishes only 80/tcp and 443/tcp. Point both DNS records to this RF VPS IP:",
      "",
      "```text",
      "<runtime node.host> -> RF VPS IP",
      "<subscription hostname> -> RF VPS IP",
      "```",
      "",
      "Local file inside this bundle:",
      "",
      "```text",
      "public/sub/<clientAccess.users[].subscriptionToken>",
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
