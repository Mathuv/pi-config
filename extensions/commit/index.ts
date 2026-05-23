import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { registerCommitCommands, __test__ } = require("./core.cjs");

export default function commitExtension(pi: ExtensionAPI) {
	registerCommitCommands(pi, { complete });
}

export { __test__ };
