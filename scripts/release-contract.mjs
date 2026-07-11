const releaseTagPattern =
  /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

const failure = (error) => ({ ok: false, error });

export const verifyReleaseIdentity = ({ tag, rootPackage, createPackage }) => {
  if (typeof tag !== "string" || !releaseTagPattern.test(tag)) {
    return failure("Release tag must be v followed by a SemVer version without build metadata.");
  }
  const version = tag.slice(1);
  if (rootPackage?.name !== "tachyon-dom" || rootPackage.version !== version) {
    return failure(`The root package version must equal ${version}.`);
  }
  if (createPackage?.name !== "create-tachyon-dom" || createPackage.version !== version) {
    return failure(`The create-tachyon-dom version must equal ${version}.`);
  }
  if (createPackage.dependencies?.["tachyon-dom"] !== version) {
    return failure(`The create-tachyon-dom tachyon-dom dependency must equal ${version} exactly.`);
  }
  return { ok: true, version, npmTag: version.includes("-") ? "next" : "latest" };
};
