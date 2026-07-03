#!/usr/bin/env node
import { runCli } from "tachyon-dom/cli";

await runCli(process.argv.slice(2), "create-tachyon-dom");
