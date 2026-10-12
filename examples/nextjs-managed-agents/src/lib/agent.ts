import {
  createManagedAgent,
  type ManagedAgentDriver,
} from "@chat-adapter/managed-agents";
import { createClaudeDriver } from "@chat-adapter/managed-agents/claude";
import { createCursorDriver } from "@chat-adapter/managed-agents/cursor";

/** Picks the agent provider from AGENT_PROVIDER: "claude" (default) or "cursor". */
function createDriver(): ManagedAgentDriver {
  const provider = process.env.AGENT_PROVIDER ?? "claude";

  if (provider === "claude") {
    // Reads ANTHROPIC_API_KEY, CLAUDE_AGENT_ID, and CLAUDE_ENVIRONMENT_ID.
    return createClaudeDriver();
  }

  if (provider === "cursor") {
    const repoUrl = process.env.CURSOR_REPO_URL;
    // The Cursor SDK reads CURSOR_API_KEY.
    return createCursorDriver({
      agent: {
        cloud: { repos: repoUrl ? [{ url: repoUrl }] : [] },
        model: { id: process.env.CURSOR_MODEL ?? "composer-2.5" },
      },
    });
  }

  throw new Error(
    `Unknown AGENT_PROVIDER "${provider}". Use "claude" or "cursor".`
  );
}

export const agent = createManagedAgent({ driver: createDriver() });
