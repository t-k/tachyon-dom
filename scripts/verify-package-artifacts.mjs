import { verifyPackageArtifacts } from "../dist/package-integrity.js";

const result = await verifyPackageArtifacts({ packageDir: process.cwd(), checkPack: true });
if (!result.ok) {
  console.error(result.error);
  process.exitCode = 1;
}
