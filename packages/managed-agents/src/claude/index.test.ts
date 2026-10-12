import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { collect } from "../test-utils";
import type { ManagedAgentEvent } from "../types";
import { createClaudeDriver } from "./index";

type Event = Record<string, unknown> & { type: string };

function fakeClient(options: {
  events: Event[];
  retrieve?: () => Promise<unknown>;
  sent?: Event[];
}) {
  const controller = new AbortController();
  const send = vi.fn(() =>
    Promise.resolve({
      data: options.sent ?? [{ id: "evt_user", type: "user.message" }],
    })
  );
  const stream = vi.fn(() =>
    Promise.resolve({
      controller,
      async *[Symbol.asyncIterator]() {
        for (const event of options.events) {
          if (controller.signal.aborted) {
            throw new Error("aborted");
          }
          yield event;
        }
      },
    })
  );
  const create = vi.fn(() => Promise.resolve({ id: "sesn_123" }));
  const retrieve = vi.fn(options.retrieve ?? (() => Promise.resolve({})));
  const client = {
    beta: { sessions: { create, events: { send, stream }, retrieve } },
  } as unknown as Anthropic;
  return { client, controller, create, retrieve, send, stream };
}

const idle = (stop_reason: Record<string, unknown>): Event => ({
  id: "evt_idle",
  stop_reason,
  type: "session.status_idle",
});

function driverFor(client: Anthropic) {
  return createClaudeDriver({
    agentId: "agent_1",
    client,
    environmentId: "env_1",
  });
}

function turn(client: Anthropic, signal = new AbortController().signal) {
  return collect(
    driverFor(client).runTurn({ sessionId: "sesn_123", signal, text: "Hi" })
  );
}

describe("createClaudeDriver", () => {
  it("creates sessions tagged with the chat thread", async () => {
    const { client, create } = fakeClient({ events: [] });
    const driver = createClaudeDriver({
      agentId: "agent_1",
      client,
      environmentId: "env_1",
      sessionParams: { metadata: { team: "support" }, vault_ids: ["vlt_1"] },
    });

    await expect(
      driver.createSession({ threadId: "slack:C1:1.2", title: "Question" })
    ).resolves.toBe("sesn_123");
    expect(create).toHaveBeenCalledWith({
      agent: "agent_1",
      environment_id: "env_1",
      metadata: { chat_thread_id: "slack:C1:1.2", team: "support" },
      title: "Question",
      vault_ids: ["vlt_1"],
    });
  });

  it("opens the stream before sending the user message", async () => {
    const { client, send, stream } = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        idle({ type: "end_turn" }),
      ],
    });

    await turn(client);

    expect(stream.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0] ?? 0
    );
    expect(send).toHaveBeenCalledWith("sesn_123", {
      events: [
        { content: [{ text: "Hi", type: "text" }], type: "user.message" },
      ],
    });
  });

  it("skips events from earlier turns and streams previews and messages", async () => {
    const { client } = fakeClient({
      events: [
        {
          content: [{ text: "stale", type: "text" }],
          id: "evt_old",
          type: "agent.message",
        },
        { id: "evt_user", type: "user.message" },
        { event: { id: "msg_1", type: "agent.message" }, type: "event_start" },
        {
          delta: {
            content: { text: "Hel", type: "text" },
            index: 0,
            type: "content_delta",
          },
          event_id: "msg_1",
          type: "event_delta",
        },
        {
          delta: {
            content: { text: "lo", type: "text" },
            index: 0,
            type: "content_delta",
          },
          event_id: "msg_1",
          type: "event_delta",
        },
        {
          content: [
            { text: "Hello, ", type: "text" },
            { text: "world", type: "text" },
          ],
          id: "msg_1",
          type: "agent.message",
        },
        idle({ type: "end_turn" }),
      ],
    });

    expect(await turn(client)).toEqual([
      { messageId: "msg_1", text: "Hel", type: "text-delta" },
      { messageId: "msg_1", text: "lo", type: "text-delta" },
      { messageId: "msg_1", text: "Hello, world", type: "message" },
      { reason: "complete", type: "turn-end" },
    ]);
  });

  it("maps tool calls and results", async () => {
    const { client } = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        {
          id: "tu_1",
          input: { query: "q" },
          name: "web_search",
          type: "agent.tool_use",
        },
        {
          id: "tr_1",
          is_error: false,
          tool_use_id: "tu_1",
          type: "agent.tool_result",
        },
        {
          id: "mcp_1",
          input: {},
          mcp_server_name: "linear",
          name: "list_issues",
          type: "agent.mcp_tool_use",
        },
        {
          id: "mr_1",
          is_error: true,
          mcp_tool_use_id: "mcp_1",
          type: "agent.mcp_tool_result",
        },
        idle({ type: "end_turn" }),
      ],
    });

    expect(await turn(client)).toEqual([
      { id: "tu_1", name: "web_search", status: "running", type: "tool-call" },
      { id: "tu_1", status: "complete", type: "tool-call" },
      {
        id: "mcp_1",
        name: "list_issues",
        status: "running",
        type: "tool-call",
      },
      { id: "mcp_1", status: "error", type: "tool-call" },
      { reason: "complete", type: "turn-end" },
    ]);
  });

  it("turns requires_action into an approval request", async () => {
    const { client } = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        {
          id: "tu_1",
          input: { command: "ls" },
          name: "bash",
          type: "agent.tool_use",
        },
        idle({ event_ids: ["tu_1", "tu_missing"], type: "requires_action" }),
      ],
    });

    const events = await turn(client);

    expect(events.at(-1)).toEqual({
      requestId: "tu_1,tu_missing",
      tools: [
        { id: "tu_1", input: { command: "ls" }, name: "bash" },
        { id: "tu_missing", name: "Tool" },
      ],
      type: "approval-request",
    });
  });

  it("stops instead of asking for approval for custom tools", async () => {
    const { client } = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        {
          id: "ct_1",
          input: {},
          name: "lookup",
          type: "agent.custom_tool_use",
        },
        idle({ event_ids: ["ct_1"], type: "requires_action" }),
      ],
    });

    expect(await turn(client)).toEqual([
      {
        detail: "custom tool results are not supported",
        reason: "stopped",
        type: "turn-end",
      },
    ]);
  });

  it("reports early stops, ended sessions, and dropped streams", async () => {
    const stopped = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        idle({ type: "budget_reached" }),
      ],
    });
    expect(await turn(stopped.client)).toEqual([
      { detail: "budget_reached", reason: "stopped", type: "turn-end" },
    ]);

    const terminated = fakeClient({
      events: [{ id: "evt_old", type: "session.status_terminated" }],
    });
    expect(await turn(terminated.client)).toEqual([{ type: "session-ended" }]);

    const dropped = fakeClient({
      events: [{ id: "evt_user", type: "user.message" }],
    });
    expect(await turn(dropped.client)).toEqual([]);
  });

  it("sends tool confirmations for every pending tool", async () => {
    const { client, send } = fakeClient({
      events: [
        { id: "evt_confirm_2", type: "user.tool_confirmation" },
        {
          content: [{ text: "Done", type: "text" }],
          id: "msg_2",
          type: "agent.message",
        },
        idle({ type: "end_turn" }),
      ],
      sent: [
        { id: "evt_confirm_1", type: "user.tool_confirmation" },
        { id: "evt_confirm_2", type: "user.tool_confirmation" },
      ],
    });
    const driver = driverFor(client);
    const respond = driver.respondToApproval;
    if (!respond) {
      throw new Error("Claude driver must support approvals");
    }

    const events = await collect(
      respond({
        approved: false,
        requestId: "tu_1,tu_2",
        sessionId: "sesn_123",
        signal: new AbortController().signal,
      })
    );

    expect(send).toHaveBeenCalledWith("sesn_123", {
      events: [
        { result: "deny", tool_use_id: "tu_1", type: "user.tool_confirmation" },
        { result: "deny", tool_use_id: "tu_2", type: "user.tool_confirmation" },
      ],
    });
    expect(events).toEqual([
      { messageId: "msg_2", text: "Done", type: "message" },
      { reason: "complete", type: "turn-end" },
    ]);
  });

  it("interrupts the session when the turn is aborted", async () => {
    const abort = new AbortController();
    const { client, controller, send } = fakeClient({
      events: [
        { id: "evt_user", type: "user.message" },
        {
          content: [{ text: "Working", type: "text" }],
          id: "msg_1",
          type: "agent.message",
        },
        idle({ type: "end_turn" }),
      ],
    });
    const events = driverFor(client).runTurn({
      sessionId: "sesn_123",
      signal: abort.signal,
      text: "Hi",
    });

    const seen: ManagedAgentEvent[] = [];
    for await (const event of events) {
      seen.push(event);
      abort.abort();
    }

    expect(seen).toEqual([
      { messageId: "msg_1", text: "Working", type: "message" },
    ]);
    expect(send).toHaveBeenLastCalledWith("sesn_123", {
      events: [{ type: "user.interrupt" }],
    });
    expect(controller.signal.aborted).toBe(true);
  });

  describe("resumeSession", () => {
    const session = (overrides: Record<string, unknown> = {}) => ({
      agent: { id: "agent_1" },
      archived_at: null,
      status: "idle",
      ...overrides,
    });

    it("accepts active sessions owned by the agent", async () => {
      const { client } = fakeClient({
        events: [],
        retrieve: () => Promise.resolve(session()),
      });
      await expect(driverFor(client).resumeSession("sesn_123")).resolves.toBe(
        true
      );
    });

    it("rejects foreign, archived, terminated, missing, and malformed sessions", async () => {
      const cases = [
        session({ agent: { id: "agent_other" } }),
        session({ archived_at: "2026-01-01T00:00:00Z" }),
        session({ status: "terminated" }),
      ];
      for (const value of cases) {
        const { client } = fakeClient({
          events: [],
          retrieve: () => Promise.resolve(value),
        });
        await expect(driverFor(client).resumeSession("sesn_123")).resolves.toBe(
          false
        );
      }

      const notFound = new Anthropic.NotFoundError(
        404,
        undefined,
        "missing",
        new Headers()
      );
      const missing = fakeClient({
        events: [],
        retrieve: () => Promise.reject(notFound),
      });
      await expect(
        driverFor(missing.client).resumeSession("sesn_123")
      ).resolves.toBe(false);

      const malformed = fakeClient({ events: [] });
      await expect(
        driverFor(malformed.client).resumeSession("../etc")
      ).resolves.toBe(false);
      expect(malformed.retrieve).not.toHaveBeenCalled();
    });

    it("rethrows transient failures", async () => {
      const { client } = fakeClient({
        events: [],
        retrieve: () => Promise.reject(new Error("network")),
      });
      await expect(driverFor(client).resumeSession("sesn_123")).rejects.toThrow(
        "network"
      );
    });
  });
});
