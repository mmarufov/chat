import {
  createManagedAgent,
  type ManagedAgentDriver,
} from "@chat-adapter/managed-agents";
import { createClaudeDriver } from "@chat-adapter/managed-agents/claude";
import { createCursorDriver } from "@chat-adapter/managed-agents/cursor";

function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Picks the agent provider from AGENT_PROVIDER: "claude" (default) or "cursor". */
function createDriver(): ManagedAgentDriver {
  const provider = process.env.AGENT_PROVIDER ?? "claude";

  if (provider === "claude") {
    // Reads ANTHROPIC_API_KEY from the environment.
    return createClaudeDriver({
      agentId: env("CLAUDE_AGENT_ID"),
      environmentId: env("CLAUDE_ENVIRONMENT_ID"),
    });
  }

  if (provider === "cursor") {
    const repoUrl = process.env.CURSOR_REPO_URL;
    return createCursorDriver({
      agent: {
        apiKey: env("CURSOR_API_KEY"),
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
