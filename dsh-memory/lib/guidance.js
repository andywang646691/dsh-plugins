// Hermes system-prompt guidance (agent/prompt_builder.py, commit 8d7061f), verbatim except tool
// names mapped to DSH (skill_view -> skill).
import { SKILLS_GUIDANCE } from './review-prompts.js';

// build_memory_guidance(memory_enabled=True, profile_enabled=True, skill_manage_available=True)
export const MEMORY_GUIDANCE =
  "You have persistent memory, carried across sessions and loaded into each new session's context; " +
  "the memory tool's schema defines what belongs there. " +
  "Skills come first: when you learn something while doing a task — a procedure, a pitfall, and the " +
  "user's preferences and corrections for that kind of work — record it in the skill you used or built " +
  "for the task (skill_manage), where it loads only when relevant. " +
  "Memory is the narrow exception for facts that apply to EVERY session regardless of task (who the " +
  "user is, environment facts, standing conventions with no task home); it has a hard character budget, " +
  "so when it fills, replace or consolidate stale entries rather than skipping the save. Write entries as " +
  "declarative facts, not instructions to yourself: 'User prefers concise responses' ✓ — 'Always respond " +
  "concisely' ✗ (imperative phrasing gets re-read as a directive in later sessions and can override the " +
  "user's current request). A fact stale within a week belongs in session history; procedures and " +
  "workflows belong in skills.";

export const SESSION_SEARCH_GUIDANCE =
  "When the user references something from a past conversation or you suspect relevant cross-session " +
  "context exists, use session_search to recall it before asking them to repeat themselves.";

// Hermes ## Skills section rule text (prompt_builder.py:1340-1358); DSH lists the catalog itself
// in <available_skills>, so only the loading rules are added here.
export const SKILLS_LOADING_RULES =
  "## Skills\n" +
  "Before replying, scan the available skills. If a skill matches or is even partially relevant to your " +
  "task, you MUST load it with the skill tool and follow its instructions. Err on the side of loading — it " +
  "is always better to have context you don't need than to miss critical steps, pitfalls, or established " +
  "workflows. Skills contain specialized knowledge — API endpoints, tool-specific commands, and proven " +
  "workflows that outperform general-purpose approaches. Load the skill even if you think you could handle " +
  "the task with basic tools like bash, read or grep. Skills also encode the user's preferred approach, " +
  "conventions, and quality standards for tasks like code review, planning, and testing — load them even " +
  "for tasks you already know how to do, because the skill defines how it should be done here.\n" +
  "If a skill has issues, fix it with skill_manage (patch).\n" +
  "After difficult/iterative tasks, offer to save as a skill. If a skill you loaded was missing steps, had " +
  "wrong commands, or needed pitfalls you discovered, update it before finishing.\n" +
  "Only proceed without loading a skill if genuinely none are relevant to the task.";

export function buildGuidance({ sessionSearch = true } = {}) {
  return [
    '# Persistent memory and skills',
    MEMORY_GUIDANCE,
    SKILLS_GUIDANCE,
    sessionSearch ? SESSION_SEARCH_GUIDANCE : null,
    SKILLS_LOADING_RULES,
  ].filter(Boolean).join('\n\n');
}
