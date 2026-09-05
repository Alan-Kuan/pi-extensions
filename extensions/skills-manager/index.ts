import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import fuzzysort from "fuzzysort";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// In-memory set of disabled skill names
let disabledSkillNames = new Set<string>();

type SkillScope = "project" | "user";

interface SkillItem {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: SkillScope;
  disabled: boolean;
  disableModelInvocation: boolean;
}

function getDisabledSkillsPath(cwd: string, scope: SkillScope): string {
  return scope === "project"
    ? path.join(cwd, ".pi", "disabled-skills.json")
    : path.join(os.homedir(), ".pi", "agent", "disabled-skills.json");
}

function readDisabledSkills(filePath: string): Set<string> {
  try {
    if (!fs.existsSync(filePath)) return new Set<string>();
    const list = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return Array.isArray(list)
      ? new Set(list.filter((name): name is string => typeof name === "string"))
      : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

function loadDisabledSkills(cwd: string): Set<string> {
  const disabledSet = readDisabledSkills(getDisabledSkillsPath(cwd, "user"));
  for (const name of readDisabledSkills(getDisabledSkillsPath(cwd, "project"))) {
    disabledSet.add(name);
  }
  return disabledSet;
}

function saveDisabledSkills(cwd: string, disabledSet: Set<string>, scope: SkillScope): void {
  const targetPath = getDisabledSkillsPath(cwd, scope);

  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data = JSON.stringify(Array.from(disabledSet), null, 2);
    fs.writeFileSync(targetPath, data, "utf-8");
  } catch {}
}

function isPathInside(filePath: string, directory: string): boolean {
  const relativePath = path.relative(directory, filePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function getSkillScope(skill: any, cwd: string): SkillScope {
  const filePath = typeof skill.filePath === "string" ? path.resolve(skill.filePath) : "";
  const projectSkillDirs = [path.join(cwd, ".pi", "skills"), path.join(cwd, ".agents", "skills")];
  const userSkillDirs = [
    path.join(os.homedir(), ".pi", "agent", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];

  if (projectSkillDirs.some((directory) => isPathInside(filePath, directory))) return "project";
  if (userSkillDirs.some((directory) => isPathInside(filePath, directory))) return "user";

  // Keep compatibility with loader-provided skills that do not come from one
  // of the standard filesystem locations (for example built-in skills).
  return skill.sourceInfo?.scope === "project" ? "project" : "user";
}

// Sort skills: project-scoped first, then user-scoped
function sortSkillsByScope(skills: SkillItem[]): SkillItem[] {
  return [...skills].sort((a, b) => {
    const scopeA = a.scope;
    const scopeB = b.scope;
    const orderA = { project: 0, user: 1 }[scopeA];
    const orderB = { project: 0, user: 1 }[scopeB];
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.name.localeCompare(b.name);
  });
}

function getAllInstalledSkills(cwd: string, rawSystemPromptSkills?: any[]): SkillItem[] {
  const disabledSet = loadDisabledSkills(cwd);
  const skillMap = new Map<string, any>();

  try {
    const userSkillsDir = path.join(os.homedir(), ".pi", "agent", "skills");
    const userAgentsDir = path.join(os.homedir(), ".agents", "skills");
    const projectSkillsDir = path.join(cwd, ".pi", "skills");
    const projectAgentsDir = path.join(cwd, ".agents", "skills");

    const extraPaths = [userSkillsDir, userAgentsDir, projectSkillsDir, projectAgentsDir].filter(
      (p) => fs.existsSync(p),
    );

    const result = loadSkills({
      cwd,
      agentDir: path.join(os.homedir(), ".pi", "agent"),
      skillPaths: extraPaths,
      includeDefaults: true,
    });

    for (const s of result.skills || []) {
      skillMap.set(s.name, s);
    }
  } catch {}

  if (Array.isArray(rawSystemPromptSkills)) {
    for (const s of rawSystemPromptSkills) {
      if (s && s.name) {
        skillMap.set(s.name, s);
      }
    }
  }

  const items = Array.from(skillMap.values()).map((s: any) => ({
    name: s.name,
    description: s.description || "(No description provided)",
    filePath: s.filePath,
    baseDir: s.baseDir,
    scope: getSkillScope(s, cwd),
    disabled: disabledSet.has(s.name),
    disableModelInvocation: Boolean(s.disableModelInvocation),
  }));

  return sortSkillsByScope(items);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: SkillItem[]): string {
  const visibleSkills = skills.filter((s) => !s.disabled);

  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];

  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }

  lines.push("</available_skills>");

  return lines.join("\n");
}

function getSkillInvocationName(text: string): string | undefined {
  const match = text.trimStart().match(/^\/skill:([^\s]+)(?:\s|$)/);
  return match?.[1];
}

function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
    } else if (currentLine.length + 1 + word.length <= maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

// Helper to highlight matched characters cleanly with separate base and match styling
function highlightMatch(
  text: string,
  query: string,
  t: any,
  baseColorFn: (s: string) => string,
  matchColorFn: (s: string) => string,
): string {
  if (!query.trim()) return baseColorFn(text);
  const tokens = query
    .toLowerCase()
    .split(/[\s/]+/)
    .filter(Boolean);
  const lowerText = text.toLowerCase();
  const matchedIndices = new Set<number>();

  for (const token of tokens) {
    // Prefer a complete token even when earlier characters could form a
    // weaker fuzzy subsequence.
    const exactIndex = lowerText.indexOf(token);
    if (exactIndex !== -1) {
      for (let i = exactIndex; i < exactIndex + token.length; i++) {
        matchedIndices.add(i);
      }
      continue;
    }

    let qIdx = 0;
    for (let i = 0; i < text.length && qIdx < token.length; i++) {
      if (lowerText[i] === token[qIdx]) {
        matchedIndices.add(i);
        qIdx++;
      }
    }
  }

  if (matchedIndices.size === 0) return baseColorFn(text);

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (matchedIndices.has(i)) {
      result += matchColorFn(char);
    } else {
      result += baseColorFn(char);
    }
  }
  return result;
}

class SkillsSelectorComponent {
  private allSkillItems: SkillItem[];
  private filteredItems: SkillItem[];
  private searchQuery: string = "";
  private selectedIndex: number = 0;
  private scrollOffset: number = 0;
  private maxVisible: number = 8;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private theme: any;
  private cwd: string;

  public onSelect?: (
    result: { action: "insert"; skillName: string } | { action: "cancel" },
  ) => void;
  public onWarning?: (message: string) => void;

  constructor(skillItems: SkillItem[], theme: any, cwd: string, initialQuery: string = "") {
    this.allSkillItems = [...skillItems].sort((a, b) => a.name.localeCompare(b.name));
    this.filteredItems = [...this.allSkillItems];
    this.theme = theme;
    this.cwd = cwd;
    if (initialQuery) {
      this.searchQuery = initialQuery;
      this.applyFilter();
    }
  }

  private applyFilter(): void {
    const query = this.searchQuery.trim();
    if (!query) {
      this.filteredItems = [...this.allSkillItems];
    } else {
      // Match name + description combined as a single string (excluding scope).
      // Keep the search text separate so fuzzysort can rank the original items.
      const searchableItems = this.allSkillItems.map((item) => ({
        item,
        searchText: `${item.name} ${item.description}`,
      }));
      const searchResults = fuzzysort
        .go(query, searchableItems, { key: "searchText" })
        .sort((a, b) => b.score - a.score || a.obj.item.name.localeCompare(b.obj.item.name));
      this.filteredItems = searchResults.map((result) => result.obj.item);
    }
    this.selectedIndex = 0;
    this.scrollOffset = 0;
  }

  handleInput(data: string): void {
    // 1. Cancel
    if (matchesKey(data, Key.ctrl("c"))) {
      this.onSelect?.({ action: "cancel" });
      return;
    }

    // 2. Clear search query
    if (matchesKey(data, Key.ctrl("u"))) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = "";
        this.applyFilter();
        this.invalidate();
      }
      return;
    }

    // 3. Navigation (Up / Down)
    if (matchesKey(data, Key.up)) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex =
          (this.selectedIndex - 1 + this.filteredItems.length) % this.filteredItems.length;
        this.updateScroll();
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (this.filteredItems.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.filteredItems.length;
        this.updateScroll();
        this.invalidate();
      }
      return;
    }

    // 4. Space: Toggle enable/disable status and save to persistent file
    if (matchesKey(data, Key.space) || data === " ") {
      if (this.filteredItems.length > 0) {
        const item = this.filteredItems[this.selectedIndex];
        if (item) {
          const scopedDisabledSkills = readDisabledSkills(
            getDisabledSkillsPath(this.cwd, item.scope),
          );
          if (disabledSkillNames.has(item.name)) {
            disabledSkillNames.delete(item.name);
            scopedDisabledSkills.delete(item.name);
            item.disabled = false;
          } else {
            disabledSkillNames.add(item.name);
            scopedDisabledSkills.add(item.name);
            item.disabled = true;
          }
          saveDisabledSkills(this.cwd, scopedDisabledSkills, item.scope);
          this.invalidate();
        }
      }
      return;
    }

    // 5. Enter: Confirm selection to insert /skill:name
    if (matchesKey(data, Key.enter)) {
      if (this.filteredItems.length > 0) {
        const item = this.filteredItems[this.selectedIndex];
        if (item && this.onSelect) {
          if (item.disabled || disabledSkillNames.has(item.name)) {
            this.onWarning?.(`Skill "${item.name}" is disabled.`);
            return;
          }
          this.onSelect({ action: "insert", skillName: item.name });
        }
      }
      return;
    }

    // 6. Escape: Clear search query first, or cancel if query is empty
    if (matchesKey(data, Key.escape)) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = "";
        this.applyFilter();
        this.invalidate();
      } else if (this.onSelect) {
        this.onSelect({ action: "cancel" });
      }
      return;
    }

    // 7. Backspace / Delete: Remove character from search query
    if (
      matchesKey(data, Key.backspace) ||
      matchesKey(data, Key.delete) ||
      data === "\x7f" ||
      data === "\b"
    ) {
      if (this.searchQuery.length > 0) {
        this.searchQuery = this.searchQuery.slice(0, -1);
        this.applyFilter();
        this.invalidate();
      }
      return;
    }

    // 8. Character input for fuzzy search as you type
    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.searchQuery += data;
      this.applyFilter();
      this.invalidate();
      return;
    }
  }

  private updateScroll(): void {
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + this.maxVisible) {
      this.scrollOffset = this.selectedIndex - this.maxVisible + 1;
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const t = this.theme;

    // Header title
    const titleStr = t.fg("accent", t.bold(" Installed Skills "));
    const headerBar =
      `─ ${titleStr} ` + "─".repeat(Math.max(0, width - visibleWidth(titleStr) - 3));
    lines.push(truncateToWidth(headerBar, width));

    // Search Bar
    const searchPrompt = t.fg("accent", "  🔍 Search: ");
    let searchContent = "";
    if (this.searchQuery) {
      const matchCount = t.fg("dim", ` (${this.filteredItems.length} matches)`);
      searchContent = t.fg("text", t.bold(this.searchQuery)) + matchCount;
    } else {
      searchContent = t.fg("dim", "(type to fuzzy search...)");
    }
    lines.push(truncateToWidth(searchPrompt + searchContent, width));

    // Controls help bar
    const helpText =
      "  " +
      t.fg("text", "↑↓") +
      t.fg("dim", ": Navigate • ") +
      t.fg("text", "Space") +
      t.fg("dim", ": Toggle • ") +
      t.fg("text", "Enter") +
      t.fg("dim", ": Insert • ") +
      t.fg("text", "Esc") +
      t.fg("dim", ": Clear/Close • ") +
      t.fg("text", "Ctrl+U") +
      t.fg("dim", ": Clear • ") +
      t.fg("text", "Ctrl+C") +
      t.fg("dim", ": Close");
    lines.push(truncateToWidth(helpText, width));
    lines.push("");

    if (this.filteredItems.length === 0) {
      lines.push(truncateToWidth(t.fg("warning", "  No matching skills found."), width));
    } else {
      const endIndex = Math.min(this.filteredItems.length, this.scrollOffset + this.maxVisible);

      for (let i = this.scrollOffset; i < endIndex; i++) {
        const item = this.filteredItems[i];
        const isSelected = i === this.selectedIndex;

        // Status indicator: [✓] enabled, [ ] disabled
        const statusText = item.disabled ? t.fg("muted", "[ ]") : t.fg("success", "[✓]");

        // Scope tag (using [proj] for project-scoped skills)
        const scopeTag =
          item.scope === "project" ? t.fg("accent", "[proj]") : t.fg("dim", "[user]");

        // Prefix & Selection Highlighting
        const cursorPrefix = isSelected ? t.fg("accent", " → ") : "   ";

        // Selection priority: selected row gets accent bold base color.
        // Match color follows the active Pi theme.
        const baseColorFn = isSelected
          ? (s: string) => t.fg("accent", t.bold(s))
          : (s: string) => t.fg("text", s);
        const matchColorFn = (s: string) => t.fg("warning", t.bold(s));

        const nameStr = highlightMatch(item.name, this.searchQuery, t, baseColorFn, matchColorFn);
        const highlightedDesc = highlightMatch(
          item.description,
          this.searchQuery,
          t,
          (s) => t.fg("dim", s),
          matchColorFn,
        );
        const descStr = ` - ${highlightedDesc}`;

        const fullLine = `${cursorPrefix}${statusText} ${scopeTag} ${nameStr}${descStr}`;
        lines.push(truncateToWidth(fullLine, width));
      }

      // Scroll indicator
      if (this.filteredItems.length > this.maxVisible) {
        const scrollInfo = t.fg(
          "dim",
          `  (${this.selectedIndex + 1}/${this.filteredItems.length})`,
        );
        lines.push(truncateToWidth(scrollInfo, width));
      }
    }

    lines.push("");

    // Detail box for currently selected skill with colored field names
    if (this.filteredItems.length > 0) {
      const selectedItem = this.filteredItems[this.selectedIndex];
      if (selectedItem) {
        const scopeLabel =
          selectedItem.scope === "project"
            ? t.fg("accent", "Project-scoped")
            : t.fg("dim", "User-scoped");

        const statusLabel = selectedItem.disabled
          ? t.fg("muted", "disabled")
          : t.fg("success", "enabled");

        // Model invocation status label showing true or false matching enabled/disabled colors
        const modelInvocationLabel = selectedItem.disableModelInvocation
          ? t.fg("success", "true")
          : t.fg("muted", "false");

        // Field names colored with accent bold for clear distinction
        const fieldNameSelected = t.fg("accent", t.bold("  Selected:         "));
        const fieldNameScope = t.fg("accent", t.bold("  Scope:            "));
        const fieldNameLocation = t.fg("accent", t.bold("  Location:         "));
        const fieldNameStatus = t.fg("accent", t.bold("  Status:           "));
        const fieldNameModelInv = t.fg("accent", t.bold("  Disable Model Invocation: "));
        const fieldNameDesc = t.fg("accent", t.bold("  Description:      "));

        lines.push(
          truncateToWidth(fieldNameSelected + t.fg("text", t.bold(selectedItem.name)), width),
        );
        lines.push(truncateToWidth(fieldNameScope + scopeLabel, width));
        lines.push(truncateToWidth(fieldNameLocation + t.fg("dim", selectedItem.filePath), width));
        lines.push(truncateToWidth(fieldNameStatus + statusLabel, width));
        lines.push(truncateToWidth(fieldNameModelInv + modelInvocationLabel, width));

        // Always display full description word-wrapped below
        lines.push(truncateToWidth(fieldNameDesc, width));
        const descWidth = Math.max(10, width - 6);
        const wrappedDescLines = wrapText(selectedItem.description, descWidth);
        for (const dLine of wrappedDescLines) {
          const matchColorFn = (s: string) => t.fg("warning", t.bold(s));
          const highlightedDLine = highlightMatch(
            dLine,
            this.searchQuery,
            t,
            (s) => t.fg("text", s),
            matchColorFn,
          );
          lines.push(truncateToWidth(`    ${highlightedDLine}`, width));
        }
      }
    }

    // Footer border
    const footerBar = "─".repeat(Math.max(0, width));
    lines.push(truncateToWidth(footerBar, width));

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export default function skillsManagerExtension(pi: ExtensionAPI) {
  // Load saved disabled skills configuration on session start
  pi.on("session_start", async (_event, ctx) => {
    disabledSkillNames = loadDisabledSkills(ctx.cwd);
  });

  // Block manual skill expansion before Pi resolves /skill:<name>.
  pi.on("input", (event, ctx) => {
    const skillName = getSkillInvocationName(event.text);
    if (!skillName || !disabledSkillNames.has(skillName)) {
      return { action: "continue" };
    }

    ctx.ui.notify(`Skill "${skillName}" is disabled.`, "warning");
    return { action: "handled" };
  });

  // 1. Intercept system prompt before sending to LLM, filtering out disabled skills
  pi.on("before_agent_start", async (event, _ctx) => {
    if (disabledSkillNames.size === 0) {
      return;
    }

    const rawSkills = event.systemPromptOptions?.skills || [];
    const activeSkillItems: SkillItem[] = rawSkills
      .filter((s) => !disabledSkillNames.has(s.name))
      .map((s) => ({
        name: s.name,
        description: s.description || "",
        filePath: s.filePath,
        baseDir: s.baseDir,
        scope: getSkillScope(s, event.systemPromptOptions.cwd),
        disabled: false,
        disableModelInvocation: Boolean(s.disableModelInvocation),
      }));

    const formattedSkillsSection = formatSkillsForPrompt(activeSkillItems);

    let updatedSystemPrompt = event.systemPrompt;
    const skillsSectionRegex =
      /\n\nThe following skills provide specialized instructions[\s\S]*?<\/available_skills>/;

    if (skillsSectionRegex.test(updatedSystemPrompt)) {
      updatedSystemPrompt = updatedSystemPrompt.replace(skillsSectionRegex, formattedSkillsSection);
    } else if (formattedSkillsSection) {
      updatedSystemPrompt += formattedSkillsSection;
    }

    return {
      systemPrompt: updatedSystemPrompt,
    };
  });

  // 2. Register slash command: /skills
  pi.registerCommand("skills", {
    description: "View, search, toggle, and insert project-scoped and user-scoped skills",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options = ["all", "project", "user"];
      const trimmed = prefix.trimStart().toLowerCase();
      const matched = options.filter((opt) => opt.startsWith(trimmed));
      return matched.length > 0 ? matched.map((opt) => ({ value: opt, label: opt })) : null;
    },
    handler: async (args, ctx: ExtensionCommandContext) => {
      const initialArg = args.trim();
      const lowerArg = initialArg.toLowerCase();

      const systemPromptOpts =
        typeof ctx.getSystemPromptOptions === "function"
          ? ctx.getSystemPromptOptions()
          : ({} as any);
      const rawSkills = systemPromptOpts.skills || [];

      // Get all currently installed skills (sorted with project-scoped first)
      const skillItems = getAllInstalledSkills(ctx.cwd, rawSkills);

      if (skillItems.length === 0) {
        const msg = "No installed skills found.";
        if (!ctx.hasUI) {
          console.log(msg);
        }
        ctx.ui.notify(msg, "info");
        return;
      }

      // Filter items based on subcommand (/skills project or /skills user)
      let targetSkillItems = skillItems;
      if (lowerArg === "project") {
        targetSkillItems = skillItems.filter((s) => s.scope === "project");
      } else if (lowerArg === "user") {
        targetSkillItems = skillItems.filter((s) => s.scope === "user");
      }

      if (!ctx.hasUI) {
        // Fallback for non-UI mode
        const projectSkills = targetSkillItems.filter((s) => s.scope === "project");
        const userSkills = targetSkillItems.filter((s) => s.scope === "user");

        const lines: string[] = ["Installed Skills:"];
        if (projectSkills.length > 0) {
          lines.push(`\n[Project-scoped Skills (${projectSkills.length})]:`);
          for (const s of projectSkills) {
            const status = s.disabled ? "[Disabled]" : "[Enabled]";
            lines.push(
              `  - ${s.name} ${status} (Disable Model Invocation: ${s.disableModelInvocation}): ${s.description} (${s.filePath})`,
            );
          }
        }
        if (userSkills.length > 0) {
          lines.push(`\n[User-scoped Skills (${userSkills.length})]:`);
          for (const s of userSkills) {
            const status = s.disabled ? "[Disabled]" : "[Enabled]";
            lines.push(
              `  - ${s.name} ${status} (Disable Model Invocation: ${s.disableModelInvocation}): ${s.description} (${s.filePath})`,
            );
          }
        }
        const outputText = lines.join("\n");
        console.log(outputText);
        ctx.ui.notify(outputText, "info");
        return;
      }

      // UI Mode: Custom TUI component with fuzzy search, Space (toggle), and Enter (insert)
      const initialSearchQuery = "";

      const result = await ctx.ui.custom<
        { action: "insert"; skillName: string } | { action: "cancel" }
      >((tui, theme, _keybindings, done) => {
        const selector = new SkillsSelectorComponent(
          targetSkillItems,
          theme,
          ctx.cwd,
          initialSearchQuery,
        );
        selector.onSelect = done;
        selector.onWarning = (message) => ctx.ui.notify(message, "warning");

        return {
          render: (width: number) => selector.render(width),
          handleInput: (data: string) => {
            selector.handleInput(data);
            tui.requestRender();
          },
          invalidate: () => selector.invalidate(),
        };
      });

      if (result && result.action === "insert" && result.skillName) {
        const insertCmd = `/skill:${result.skillName} `;
        const currentText = ctx.ui.getEditorText ? ctx.ui.getEditorText() : "";

        if (!currentText || currentText.trim() === "") {
          if (typeof ctx.ui.setEditorText === "function") {
            ctx.ui.setEditorText(insertCmd);
          } else if (typeof ctx.ui.pasteToEditor === "function") {
            ctx.ui.pasteToEditor(insertCmd);
          }
        } else {
          if (typeof ctx.ui.pasteToEditor === "function") {
            ctx.ui.pasteToEditor(insertCmd);
          } else if (typeof ctx.ui.setEditorText === "function") {
            ctx.ui.setEditorText(`${currentText} ${insertCmd}`);
          }
        }
        ctx.ui.notify(`Inserted ${insertCmd.trim()} into editor`, "info");
      }
    },
  });
}
