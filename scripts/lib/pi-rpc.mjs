import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

export class PiRpcClient {
  #child;
  #closed = false;
  #decoder = new StringDecoder("utf8");
  #buffer = "";
  #pending = new Map();
  #listeners = new Set();
  #stderr = "";

  constructor({ cwd, args = [], environment = {}, executable = "pi", executableArgs = [] }) {
    this.#child = spawn(executable, [...executableArgs, ...args], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child.stdout.on("data", (chunk) => {
      this.#buffer += this.#decoder.write(chunk);
      this.#drainLines();
    });
    this.#child.stdout.on("end", () => {
      this.#buffer += this.#decoder.end();
      if (this.#buffer.length > 0) this.#consumeLine(this.#buffer.replace(/\r$/, ""));
      this.#buffer = "";
    });
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr += chunk.toString("utf8");
    });
    this.#child.once("error", (error) => this.#rejectAll(error));
    this.#child.once("close", (code, signal) => {
      this.#closed = true;
      if (this.#pending.size > 0) {
        this.#rejectAll(new Error(`Pi RPC closed: code=${code ?? "none"} signal=${signal ?? "none"}`));
      }
    });
  }

  get stderr() {
    return this.#stderr;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message) {
    if (this.#closed) throw new Error("Pi RPC is closed");
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(command, timeoutMs = 10_000) {
    const id = command.id ?? randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi RPC timeout: ${command.type}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timeout });
      this.send({ ...command, id });
    });
  }

  async close() {
    if (this.#closed) return;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
    const forceKill = setTimeout(() => this.#child.kill("SIGKILL"), 2_000);
    await once(this.#child, "close").catch(() => {});
    clearTimeout(forceKill);
  }

  #drainLines() {
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line) this.#consumeLine(line);
    }
  }

  #consumeLine(line) {
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      this.#rejectAll(new Error(`Invalid Pi RPC JSON: ${error.message}`));
      return;
    }

    if (event.type === "response" && event.id && this.#pending.has(event.id)) {
      const pending = this.#pending.get(event.id);
      this.#pending.delete(event.id);
      clearTimeout(pending.timeout);
      if (event.success) pending.resolve(event);
      else pending.reject(new Error(event.error ?? `Pi RPC command failed: ${event.command}`));
      return;
    }

    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#rejectAll(error);
      }
    }
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
