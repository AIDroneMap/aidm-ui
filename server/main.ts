import { join } from "node:path";
import pkg from "../package.json";
import { runFromCommandLine } from "./app/start.ts";
import { assetsFromFolder } from "./http/static-assets.ts";

await runFromCommandLine(await assetsFromFolder(join(import.meta.dir, "../web/dist")), pkg.version);
