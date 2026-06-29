import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await copyFile("src/tachyon-html.d.ts", "dist/tachyon-html.d.ts");
