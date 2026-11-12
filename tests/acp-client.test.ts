import { describe, expect, it } from "vitest";
import { AcpClient } from "../providers/antigravity-provider/server/internal/acp-client.js";

function launch(script: string) {
  return {
    command: process.execPath,
    args: ["--input-type=module", "-e", script],
    env: {},
  };
}

describe("ACP transport", () => {
  it("drains ordered notifications before resolving an RPC", async () => {
    const received: number[] = [];
    const client = new AcpClient({
      launch: launch(String.raw`import {createInterface} from 'node:readline';
        createInterface({input:process.stdin}).on('line', line => {
          const f = JSON.parse(line);
          const frames = [1, 2, 3].map(n => ({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{n}}}));
          frames.push({jsonrpc:'2.0',id:f.id,result:{protocolVersion:1}});
          process.stdout.write(frames.map(f => JSON.stringify(f)+'\n').join(''));
        });`),
      onSessionUpdate: async ({ update }) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        received.push(Number(update.n));
      },
    });
    try {
      await client.initialize();
      expect(received).toEqual([1, 2, 3]);
    } finally {
      await client.close();
    }
  });

  it("uses clientCapabilities and sends cancel as a notification", async () => {
    const client = new AcpClient({
      launch: launch(String.raw`import {createInterface} from 'node:readline';
        let cancelled = false;
        createInterface({input:process.stdin}).on('line', line => {
          const f = JSON.parse(line);
          if (f.method === 'session/cancel') { cancelled = f.id === undefined; return; }
          const result = f.method === 'initialize'
            ? {protocolVersion:1,agentCapabilities:{clientCaps:f.params.clientCapabilities}}
            : {cancelled};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result})+'\n');
        });`),
    });
    try {
      await client.initialize();
      expect(client.agentCapabilities.clientCaps).toEqual({
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
      await client.notify("session/cancel", { sessionId: "fixture" });
      expect(await client.request("test/barrier", {})).toEqual({
        cancelled: true,
      });
    } finally {
      await client.close();
    }
  });

  it("retains upstream RPC data and diagnostic context without terminating a healthy process", async () => {
    const client = new AcpClient({
      launch: launch(String.raw`import {createInterface} from 'node:readline';
      createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);
      const result=f.method==='initialize'?{result:{protocolVersion:1}}:f.method==='session/prompt'?{error:{code:-32603,message:'Agent execution terminated due to error.',data:{detail:'service unavailable',token:'never log'}}}:{result:{alive:true}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,...result})+'\n');});`),
    });
    try {
      await client.initialize();
      const failure = await client
        .request("session/prompt", { sessionId: "fixture" }, null)
        .catch((error) => error);
      expect(failure).toMatchObject({
        message: "Agent execution terminated due to error.",
        code: "RPC_-32603",
        data: { detail: "service unavailable", token: "never log" },
      });
      expect(failure.diagnostic).toContain("service unavailable");
      expect(failure.diagnostic).not.toContain("never log");
      expect(await client.request("test/alive", {})).toEqual({ alive: true });
    } finally {
      await client.close();
    }
  });

  it("fails explicitly when notification handling fails", async () => {
    const client = new AcpClient({
      launch: launch(String.raw`import {createInterface} from 'node:readline';
        createInterface({input:process.stdin}).on('line', line => {
          const f = JSON.parse(line);
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture',update:{}}})+'\n');
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:f.id,result:{protocolVersion:1}})+'\n');
        });`),
      onSessionUpdate: () => {
        throw new Error("cannot apply update");
      },
    });
    try {
      await expect(client.initialize()).rejects.toThrow("cannot apply update");
    } finally {
      await client.close();
    }
  });
});
