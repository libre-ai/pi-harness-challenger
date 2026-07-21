import assert from "node:assert/strict";

import { assertSandboxSafeRpc } from "./safe-rpc-client.mjs";

assert.doesNotThrow(() => assertSandboxSafeRpc({ type: "prompt" }));
assert.doesNotThrow(() => assertSandboxSafeRpc({ type: "extension_ui_response" }));
assert.throws(() => assertSandboxSafeRpc({ type: "bash" }), /gondolin-rpc-command-forbidden:bash/);
assert.throws(() => assertSandboxSafeRpc({ type: "abort_bash" }), /gondolin-rpc-command-forbidden:abort_bash/);
console.log("gondolin RPC guard: ok (native host bash commands refused)");
