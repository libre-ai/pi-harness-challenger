import { PiRpcClient } from "../../scripts/lib/pi-rpc.mjs";

const FORBIDDEN_RPC_COMMANDS = new Set(["bash", "abort_bash"]);

export function assertSandboxSafeRpc(message) {
  if (FORBIDDEN_RPC_COMMANDS.has(message?.type)) throw new Error(`gondolin-rpc-command-forbidden:${message.type}`);
}

export class GondolinPiRpcClient extends PiRpcClient {
  send(message) {
    assertSandboxSafeRpc(message);
    return super.send(message);
  }

  request(command, timeoutMs) {
    assertSandboxSafeRpc(command);
    return super.request(command, timeoutMs);
  }
}
