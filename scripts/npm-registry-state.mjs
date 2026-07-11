const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const parseSemVer = (version) => {
  const match = typeof version === "string" ? semverPattern.exec(version) : null;
  if (!match) throw new Error(`Invalid SemVer version: ${String(version)}.`);
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
};

const compareIdentifiers = (left, right) => {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
};

export const compareSemVer = (leftVersion, rightVersion) => {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (left.prerelease[index] === undefined) return -1;
    if (right.prerelease[index] === undefined) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared < 0 ? -1 : 1;
  }
  return 0;
};

export const decideDistTagTransition = ({ currentVersion, targetVersion }) => {
  if (currentVersion === undefined) return { ok: true, action: "update" };
  const compared = compareSemVer(currentVersion, targetVersion);
  if (compared === 0) return { ok: true, action: "noop" };
  if (compared < 0) return { ok: true, action: "update" };
  return { ok: false, error: `Refusing dist-tag rollback from ${currentVersion} to ${targetVersion}.` };
};

export const npmRegistryUrl = "https://registry.npmjs.org/";

export const readRegistryState = async ({ registryUrl = npmRegistryUrl, name, version }) => {
  const response = await fetch(new URL(encodeURIComponent(name), registryUrl), { redirect: "error" });
  if (response.status === 404) return { integrity: null, distTags: {} };
  if (!response.ok) throw new Error(`npm registry request for ${name} failed with HTTP ${response.status}.`);
  const packument = await response.json();
  if (!packument || typeof packument !== "object" || Array.isArray(packument)) {
    throw new Error(`npm registry returned an invalid packument for ${name}.`);
  }
  const rawTags = packument["dist-tags"] ?? {};
  if (!rawTags || typeof rawTags !== "object" || Array.isArray(rawTags)) {
    throw new Error(`npm registry returned invalid dist-tags for ${name}.`);
  }
  const distTags = {};
  for (const [tag, value] of Object.entries(rawTags)) {
    if (typeof value !== "string") throw new Error(`npm registry returned an invalid ${tag} dist-tag for ${name}.`);
    distTags[tag] = value;
  }
  const integrity = packument.versions?.[version]?.dist?.integrity ?? null;
  if (integrity !== null && (typeof integrity !== "string" || !integrity.startsWith("sha512-"))) {
    throw new Error(`npm registry returned invalid integrity for ${name}@${version}.`);
  }
  return { integrity, distTags };
};
