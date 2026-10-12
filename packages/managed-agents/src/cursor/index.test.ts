import { beforeEach, describe, expect, it, vi } from "vitest";
import { collect } from "../test-utils";

const sdk = vi.hoisted(() => {
  class AgentNotFoundError extends Error {}
  return {
    Agent: {
      create: vi.fn(),
      get: vi.fn(),
      resume: vi.fn(),
    },
    AgentNotFoundError,
  };
});

vi.mock("@cursor/sdk", () => sdk);

const { createCursorDriver } = await import("./index");

type Message = Record<string, unknown> & { type: string };

function fakeRun(
  messages: Message[],
  result: Record<string, unknown> = { status: "finished" }
) {
  return {
    cancel: vi.fn(() => Promise.resolve()),
    id: "run_1",
    async *stream() {
      for (const message of messages) {
        yield message;
      }
    },
    wait: vi.fn(() => Promise.resolve(result)),
  };
}

function fakeAgent(run: ReturnType<typeof fakeRun>, agentId = "bc-123") {
  return { agentId, close: vi.fn(), send: vi.fn(() => Promise.resolve(run)) };
}

const options = {
  agent: { apiKey: "key", cloud: { repos: [] } },
  send: { mode: "agent" as const },
};

const text = (value: string): Message => ({
  message: { content: [{ text: value, type: "text" }], role: "assistant" },
  type: "assistant",
});

function turn(signal = new AbortController().signal) {
  return collect(
    createCursorDriver(options).runTurn({
      sessionId: "bc-123",
      signal,
      text: "Hi",
    })
  );
}

describe("createCursorDriver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates an agent and reuses its handle for the first run", async () => {
    const run = fakeRun([text("Hello")]);
    const agent = fakeAgent(run);
    sdk.Agent.create.mockResolvedValue(agent);
    const driver = createCursorDriver(options);

    const sessionId = await driver.createSession({
      threadId: "t",
      title: "Hi",
    });
    await collect(
      driver.runTurn({
        sessionId,
        signal: new AbortController().signal,
        text: "Hi",
      })
    );

    expect(sessionId).toBe("bc-123");
    expect(sdk.Agent.create).toHaveBeenCalledWith(options.agent);
    expect(sdk.Agent.resume).not.toHaveBeenCalled();
    expect(agent.send).toHaveBeenCalledWith("Hi", options.send);
    expect(agent.close).toHaveBeenCalled();
  });

  it("resumes existing agents and streams text and tool calls", async () => {
    const run = fakeRun([
      { model: {}, type: "system" },
      text("Looking"),
      text(" now."),
      { call_id: "c1", name: "grep", status: "running", type: "tool_call" },
      { call_id: "c1", name: "grep", status: "completed", type: "tool_call" },
      text("Found it."),
    ]);
    sdk.Agent.resume.mockResolvedValue(fakeAgent(run));

    expect(await turn()).toEqual([
      { messageId: "run_1:0", text: "Looking", type: "text-delta" },
      { messageId: "run_1:0", text: " now.", type: "text-delta" },
      { id: "c1", name: "grep", status: "running", type: "tool-call" },
      { id: "c1", name: "grep", status: "complete", type: "tool-call" },
      { messageId: "run_1:1", text: "Found it.", type: "text-delta" },
      { reason: "complete", type: "turn-end" },
    ]);
    expect(sdk.Agent.resume).toHaveBeenCalledWith("bc-123", options.agent);
  });

  it("falls back to the run result when nothing streamed", async () => {
    sdk.Agent.resume.mockResolvedValue(
      fakeAgent(fakeRun([], { result: "Summary", status: "finished" }))
    );

    expect(await turn()).toEqual([
      { messageId: "run_1:0", text: "Summary", type: "message" },
      { reason: "complete", type: "turn-end" },
    ]);
  });

  it("reports failed and cancelled runs", async () => {
    sdk.Agent.resume.mockResolvedValue(
      fakeAgent(
        fakeRun([], {
          error: { code: "rate_limited", message: "x" },
          status: "error",
        })
      )
    );
    expect(await turn()).toEqual([
      { detail: "rate_limited", reason: "stopped", type: "turn-end" },
    ]);

    sdk.Agent.resume.mockResolvedValue(
      fakeAgent(fakeRun([], { status: "cancelled" }))
    );
    expect(await turn()).toEqual([{ reason: "cancelled", type: "turn-end" }]);
  });

  it("cancels runs that ask for approval", async () => {
    const run = fakeRun([{ request_id: "req_1", type: "request" }]);
    sdk.Agent.resume.mockResolvedValue(fakeAgent(run));

    expect(await turn()).toEqual([
      { requestId: "req_1", tools: [], type: "approval-request" },
    ]);
    expect(run.cancel).toHaveBeenCalled();
  });

  it("ends the session when the agent no longer exists", async () => {
    sdk.Agent.resume.mockRejectedValue(new sdk.AgentNotFoundError("gone"));

    expect(await turn()).toEqual([{ type: "session-ended" }]);
  });

  it("cancels the run when the turn is aborted", async () => {
    const abort = new AbortController();
    const run = fakeRun([text("one"), text("two")]);
    sdk.Agent.resume.mockResolvedValue(fakeAgent(run));

    const events = createCursorDriver(options).runTurn({
      sessionId: "bc-123",
      signal: abort.signal,
      text: "Hi",
    });
    for await (const _event of events) {
      abort.abort();
    }

    expect(run.cancel).toHaveBeenCalled();
    expect(run.wait).not.toHaveBeenCalled();
  });

  describe("resumeSession", () => {
    it("checks cloud agents and rejects archived or missing ones", async () => {
      const driver = createCursorDriver(options);

      sdk.Agent.get.mockResolvedValue({ agentId: "bc-123" });
      await expect(driver.resumeSession("bc-123")).resolves.toBe(true);
      expect(sdk.Agent.get).toHaveBeenCalledWith("bc-123", { apiKey: "key" });

      sdk.Agent.get.mockResolvedValue({ agentId: "bc-123", archived: true });
      await expect(driver.resumeSession("bc-123")).resolves.toBe(false);

      sdk.Agent.get.mockRejectedValue(new sdk.AgentNotFoundError("gone"));
      await expect(driver.resumeSession("bc-123")).resolves.toBe(false);

      sdk.Agent.get.mockRejectedValue(new Error("network"));
      await expect(driver.resumeSession("bc-123")).rejects.toThrow("network");
    });

    it("accepts local agents without a lookup and rejects malformed IDs", async () => {
      const driver = createCursorDriver(options);

      await expect(driver.resumeSession("agent-123")).resolves.toBe(true);
      await expect(driver.resumeSession("../x")).resolves.toBe(false);
      expect(sdk.Agent.get).not.toHaveBeenCalled();
    });
  });
});
