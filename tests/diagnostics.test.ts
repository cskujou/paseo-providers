import { describe, it, expect, vi } from "vitest";
import {
  AntigravityError,
  diagnosticDetails,
  providerError,
  logDiagnostic,
} from "../providers/antigravity-provider/server/internal/diagnostics.js";

describe("provider diagnostics", () => {
  it("preserves the upstream message, code and redacted details for Paseo", () => {
    const data = {
      detail: "service unavailable",
      reason: "upstream",
      accessToken: "private-token",
      authorization: "Bearer hidden",
      request: { prompt: "private task" },
    };
    const error = new AntigravityError(
      "Agent execution terminated due to error.",
      "RPC_-32603",
      diagnosticDetails(data),
      data,
    );
    expect(error.data).toBe(data);
    expect(providerError(error)).toEqual({
      message: "Agent execution terminated due to error.",
      code: "RPC_-32603",
      diagnostic: JSON.stringify({
        detail: "service unavailable",
        reason: "upstream",
        accessToken: "[redacted]",
        authorization: "[redacted]",
        request: { prompt: "[redacted]" },
      }),
    });
  });
  it("logs correlation facts and errors without credentials or prompt bodies", () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const error = new AntigravityError(
        "request failed password=abc Bearer xyz",
        "RPC_-32603",
        diagnosticDetails({
          detail: "unavailable",
          api_key: "secret",
          url: "https://user:pass@example.test/path?token=sensitive",
          messages: ["private task"],
        }),
      );
      logDiagnostic(
        "acp.rpc_failed",
        { method: "session/prompt", requestId: 5, turnId: "fixture" },
        error,
      );
      const text = sink.mock.calls[0]?.[0];
      expect(text).toContain('"code":"RPC_-32603"');
      expect(text).toContain('"message":"request failed');
      for (const secret of [
        "abc",
        "xyz",
        "secret",
        "sensitive",
        "private task",
        "user:pass",
      ])
        expect(text).not.toContain(secret);
    } finally {
      sink.mockRestore();
    }
  });
  it("handles cyclic upstream data and caps diagnostic output without changing task lifetime", () => {
    const data: Record<string, unknown> = { detail: "x".repeat(20000) };
    data.cause = data;
    expect(diagnosticDetails(data).length).toBeLessThan(16500);
    expect(diagnosticDetails({ token: "secret", detail: "ok" })).toBe(
      '{"token":"[redacted]","detail":"ok"}',
    );
  });
});
