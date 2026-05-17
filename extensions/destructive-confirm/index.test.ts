import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import destructiveConfirmExtension, { CONFIRM_TIMEOUT, detectBashRisk, detectPathRisk, gateToolCall, type Risk } from "./index.ts";

// ─── Bash Risk Detection ─────────────────────────────────────────────────────

void describe("detectBashRisk", () => {
  // --- File deletion (ISC-11 category) ---

  void it("detects rm -rf as high risk", () => {
    const risk = detectBashRisk("rm -rf /some/path");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects plain rm as high risk", () => {
    const risk = detectBashRisk("rm file.txt");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects shred as high risk", () => {
    const risk = detectBashRisk("shred --remove secret.pdf");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects truncate as high risk", () => {
    const risk = detectBashRisk("truncate -s 0 app.log");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  // --- Destructive SQL (ISC-13 category) ---

  void it("detects DROP TABLE as high risk", () => {
    const risk = detectBashRisk('psql -c "DROP TABLE users"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects DROP DATABASE as high risk", () => {
    const risk = detectBashRisk('mysql -e "DROP DATABASE prod"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects DELETE FROM as high risk", () => {
    const risk = detectBashRisk('psql -c "DELETE FROM sessions"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects TRUNCATE as high risk", () => {
    const risk = detectBashRisk('psql -c "TRUNCATE logs"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects SQL UPDATE as high risk", () => {
    const risk = detectBashRisk('psql -c "UPDATE users SET active = false WHERE id = 1"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  // --- HTTP DELETE via curl (ISC-11) ---

  void it("detects curl -X DELETE as medium risk", () => {
    const risk = detectBashRisk('curl -X DELETE https://api.example.com/resource');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  void it("detects curl --request DELETE as medium risk", () => {
    const risk = detectBashRisk('curl --request DELETE https://api.example.com/resource');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  // --- Destructive git (ISC-12) ---

  void it("detects git reset --hard as high risk", () => {
    const risk = detectBashRisk("git reset --hard HEAD~1");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects git push --force as high risk", () => {
    const risk = detectBashRisk("git push --force origin main");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects git push -f as high risk", () => {
    const risk = detectBashRisk("git push -f origin main");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects git branch -D as high risk", () => {
    const risk = detectBashRisk("git branch -D feature-branch");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects git commit --amend as low risk", () => {
    const risk = detectBashRisk('git commit --amend -m "new message"');
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "low");
  });

  // --- Destructive CLI verbs ---

  void it("detects gcloud delete as medium risk", () => {
    const risk = detectBashRisk("gcloud projects delete my-project");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  void it("detects kubectl delete as high risk", () => {
    const risk = detectBashRisk("kubectl delete pod my-pod");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "high");
  });

  void it("detects jira delete as medium risk", () => {
    const risk = detectBashRisk("jira delete TASK-1234");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  void it("detects gh pr close as medium risk", () => {
    const risk = detectBashRisk("gh pr close 12");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  void it("detects gh pr merge as medium risk", () => {
    const risk = detectBashRisk("gh pr merge 12");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  void it("detects gh pr delete as medium risk", () => {
    const risk = detectBashRisk("gh pr delete 12");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "bash");
    assert.equal(risk!.severity, "medium");
  });

  // --- Safe / read-only commands must NOT produce risks ---

  const safeCommands = [
    "ls -la",
    "cat file.txt",
    "git status",
    "git log --oneline",
    "git diff HEAD~1",
    "npm test",
    "curl -X GET https://api.example.com",
    "curl https://api.example.com",
    "gcloud compute instances list",
    "kubectl get pods",
    "gcloud help delete",
    "psql -c 'SELECT * FROM users'",
    "gh pr list",
    "gh issue list",
    "sudo apt update",
    "python manage.py migrate",
    "echo 'hello world'",
    "cd /tmp",
    "mv file1 file2",
    "cp file1 file2",
  ];

  for (const cmd of safeCommands) {
    void it(`does NOT flag safe command: ${cmd}`, () => {
      const risk = detectBashRisk(cmd);
      assert.equal(risk, undefined);
    });
  }
});

// ─── Gate Tool Call ──────────────────────────────────────────────────────────

void describe("gateToolCall", () => {
  const testRisk: Risk = { category: "bash", severity: "high", description: "rm -rf" };

  function makeSelect(simulatedChoice: string | undefined) {
    if (simulatedChoice === "__timeout__") {
      return async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return undefined;
      };
    }
    return async (_label: string, _options: string[], _opts?: { timeout?: number }) => simulatedChoice;
  }

  /** Simulate sequential selectFn calls (e.g. two-step confirmation). */
  function makeSequentialSelect(choices: (string | undefined)[]) {
    let callIndex = 0;
    return async (_label: string, _options: string[], _opts?: { timeout?: number }) => {
      return choices[callIndex++];
    };
  }

  void it("blocks when no UI (non-interactive mode)", async () => {
    const result = await gateToolCall(testRisk, false, makeSelect("Allow"));
    assert.equal(result.block, true);
    assert.ok(result.reason?.includes(testRisk.description));
    assert.ok(result.reason?.includes(testRisk.category));
  });

  void it("blocks when Deny (default) is selected", async () => {
    const result = await gateToolCall(testRisk, true, makeSelect("Deny (default)"));
    assert.equal(result.block, true);
    assert.ok(result.reason?.includes(testRisk.description));
    assert.ok(result.reason?.includes(testRisk.category));
  });

  void it("blocks on undefined (Escape)", async () => {
    const result = await gateToolCall(testRisk, true, makeSelect(undefined));
    assert.equal(result.block, true);
    assert.ok(result.reason?.includes(testRisk.description));
    assert.ok(result.reason?.includes(testRisk.category));
  });

  void it("blocks on timeout (select returns undefined after delay)", async () => {
    const result = await gateToolCall(testRisk, true, makeSelect("__timeout__"));
    assert.equal(result.block, true);
    assert.ok(result.reason?.includes(testRisk.description));
    assert.ok(result.reason?.includes(testRisk.category));
  });

  void it("allows when Allow once is selected", async () => {
    const result = await gateToolCall(testRisk, true, makeSelect("Allow once"));
    assert.equal(result.block, false);
    assert.equal((result as any).disableForSession, undefined);
  });

  void it("passes correct label and options to selectFn", async () => {
    let capturedLabel = "";
    let capturedOptions: string[] = [];
    let capturedTimeout: number | undefined;
    const captureFn = async (label: string, options: string[], opts?: { timeout?: number }) => {
      capturedLabel = label;
      capturedOptions = options;
      capturedTimeout = opts?.timeout;
      return "Deny (default)";
    };

    await gateToolCall(testRisk, true, captureFn);

    assert.ok(capturedLabel.includes(testRisk.description), "label should contain risk description");
    assert.deepEqual(capturedOptions, [
      "Deny (default)",
      "Allow once",
      "Allow and disable protection for this session…",
    ]);
    assert.equal(capturedTimeout, undefined);
  });

  void it("passes timeout when gateToolCall is called with timeoutMs", async () => {
    let capturedTimeout: number | undefined;
    const captureFn = async (_label: string, _options: string[], opts?: { timeout?: number }) => {
      capturedTimeout = opts?.timeout;
      return "Deny (default)";
    };

    await gateToolCall(testRisk, true, captureFn, { timeoutMs: CONFIRM_TIMEOUT });

    assert.equal(capturedTimeout, CONFIRM_TIMEOUT);
  });

  void it("block reason includes both risk category and description (regression)", async () => {
    // Non-interactive mode
    const nonInteractive = await gateToolCall(testRisk, false, makeSelect("Allow once"));
    assert.equal(nonInteractive.block, true);
    assert.ok(nonInteractive.reason?.includes(testRisk.category));
    assert.ok(nonInteractive.reason?.includes(testRisk.description));

    // Interactive mode — denied
    const denied = await gateToolCall(testRisk, true, makeSelect("Deny (default)"));
    assert.equal(denied.block, true);
    assert.ok(denied.reason?.includes(testRisk.category));
    assert.ok(denied.reason?.includes(testRisk.description));

    // Interactive mode — escape
    const escaped = await gateToolCall(testRisk, true, makeSelect(undefined));
    assert.equal(escaped.block, true);
    assert.ok(escaped.reason?.includes(testRisk.category));
    assert.ok(escaped.reason?.includes(testRisk.description));
  });

  void it("allows and disables when Allow and disable… then Yes is selected", async () => {
    const selectFn = makeSequentialSelect([
      "Allow and disable protection for this session…",
      "Yes, allow and disable for session",
    ]);
    const result = await gateToolCall(testRisk, true, selectFn);
    assert.equal(result.block, false);
    assert.equal((result as any).disableForSession, true);
  });

  void it("blocks when Allow and disable… then Cancel is selected", async () => {
    const selectFn = makeSequentialSelect([
      "Allow and disable protection for this session…",
      "Cancel (keep protection on)",
    ]);
    const result = await gateToolCall(testRisk, true, selectFn);
    assert.equal(result.block, true);
    assert.ok((result as any).reason?.includes("cancelled"));
  });

  void it("blocks when Allow and disable… then Escape is selected (second prompt undefined)", async () => {
    const selectFn = makeSequentialSelect([
      "Allow and disable protection for this session…",
      undefined,
    ]);
    const result = await gateToolCall(testRisk, true, selectFn);
    assert.equal(result.block, true);
  });

  void it("passes correct options to first and second selectFn calls", async () => {
    const capturedCalls: Array<{ options: string[]; timeout?: number }> = [];
    const captureFn = async (_label: string, options: string[], opts?: { timeout?: number }) => {
      capturedCalls.push({ options, timeout: opts?.timeout });
      if (capturedCalls.length === 1) return "Allow and disable protection for this session…";
      return "Cancel (keep protection on)";
    };

    await gateToolCall(testRisk, true, captureFn, { timeoutMs: CONFIRM_TIMEOUT });

    assert.equal(capturedCalls.length, 2);
    assert.deepEqual(capturedCalls[0].options, [
      "Deny (default)",
      "Allow once",
      "Allow and disable protection for this session…",
    ]);
    assert.deepEqual(capturedCalls[1].options, [
      "Cancel (keep protection on)",
      "Yes, allow and disable for session",
    ]);
    assert.equal(capturedCalls[0].timeout, 15000);
    assert.equal(capturedCalls[1].timeout, 15000);
  });

});

// ─── Path Risk Detection ─────────────────────────────────────────────────────

void describe("detectPathRisk", () => {
  const cwd = "/home/user/project";

  void it("detects write outside cwd as high risk", () => {
    const risk = detectPathRisk(cwd, "write", "/home/user/other/file.txt");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "write");
    assert.equal(risk!.severity, "high");
  });

  void it("detects edit outside cwd as high risk", () => {
    const risk = detectPathRisk(cwd, "edit", "/home/user/other/file.txt");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "edit");
    assert.equal(risk!.severity, "high");
  });

  void it("allows write inside cwd (no risk)", () => {
    const risk = detectPathRisk(cwd, "write", "/home/user/project/src/main.ts");
    assert.equal(risk, undefined);
  });

  void it("allows write at cwd root (no risk)", () => {
    const risk = detectPathRisk(cwd, "write", "/home/user/project");
    assert.equal(risk, undefined);
  });

  void it("handles relative path that resolves outside cwd", () => {
    const risk = detectPathRisk(cwd, "write", "../other/file.txt");
    assert.notEqual(risk, undefined);
    assert.equal(risk!.category, "write");
    assert.equal(risk!.severity, "high");
  });

  void it("allows relative path that resolves inside cwd", () => {
    const risk = detectPathRisk(cwd, "write", "src/main.ts");
    assert.equal(risk, undefined);
  });

  void it("allows write to file starting with '..' inside cwd (e.g., ..hidden.txt)", () => {
    const risk = detectPathRisk(cwd, "write", "/home/user/project/..hidden.txt");
    assert.equal(risk, undefined);
  });

  void it("handles cwd with trailing separator", () => {
    const risk = detectPathRisk("/home/user/project/", "write", "src/main.ts");
    assert.equal(risk, undefined);
  });

  // ─── Root cwd edge case ────────────────────────────────────────────────────

  void it("allows write inside root cwd (cwd === '/')", () => {
    const risk = detectPathRisk("/", "write", "/tmp/file.txt");
    assert.equal(risk, undefined);
  });

  void it("allows write at root itself (cwd === '/')", () => {
    const risk = detectPathRisk("/", "write", "/");
    assert.equal(risk, undefined);
  });

  void it("allows relative path inside root cwd (cwd === '/')", () => {
    const risk = detectPathRisk("/", "write", "tmp/file.txt");
    assert.equal(risk, undefined);
  });
});

// ─── Extension Behavior ─────────────────────────────────────────────────────

void describe("destructiveConfirmExtension", () => {
  // Save/restore env var so no test leaks PI_DISABLE_DESTRUCTIVE_CONFIRM to another
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
    } else {
      process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM = savedEnv;
    }
  });

  function createFixture() {
    const commands = new Map<string, (args: string, ctx: any) => Promise<void>>();
    let sessionStartHandler: Function | undefined;
    let toolCallHandler: Function | undefined;
    const setStatusCalls: Array<{ key: string; text: string | undefined }> = [];
    const notifyCalls: Array<{ message: string; type?: string }> = [];
    const capture = {
      opts: undefined as { timeout?: number } | undefined,
      selectResults: ["Deny (default)"] as (string | undefined)[],
      selectCalls: 0,
    };

    const pi = {
      registerCommand: (name: string, opts: any) => {
        commands.set(name, opts.handler);
      },
      on: (event: string, handler: Function) => {
        if (event === "session_start") sessionStartHandler = handler;
        if (event === "tool_call") toolCallHandler = handler;
      },
      registerTool: () => {},
      registerShortcut: () => {},
      registerFlag: () => {},
      getFlag: () => undefined,
      registerMessageRenderer: () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      appendEntry: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
      setLabel: () => {},
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      getActiveTools: () => [],
      getAllTools: () => [],
      setActiveTools: () => {},
      getCommands: () => [],
      setModel: async () => false,
      getThinkingLevel: () => "off",
      setThinkingLevel: () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
      events: {} as any,
    };

    destructiveConfirmExtension(pi as any);

    const ctx = {
      hasUI: true,
      cwd: "/test",
      ui: {
        select: (_label: string, _options: string[], opts?: { timeout?: number }) => {
          capture.opts = opts;
          const idx = Math.min(capture.selectCalls, capture.selectResults.length - 1);
          capture.selectCalls++;
          return capture.selectResults[idx];
        },
        setStatus: (key: string, text: string | undefined) => {
          setStatusCalls.push({ key, text });
        },
        notify: (message: string, type?: string) => {
          notifyCalls.push({ message, type });
        },
        theme: {
          fg: (_style: string, text: string) => text,
        } as any,
        confirm: async () => false,
        input: async () => undefined,
        onTerminalInput: () => () => {},
        setWorkingMessage: () => {},
        setWorkingVisible: () => {},
        setWorkingIndicator: () => {},
        setHiddenThinkingLabel: () => {},
        setWidget: () => {},
        setFooter: () => {},
        setHeader: () => {},
        setTitle: () => {},
        custom: async () => undefined,
        pasteToEditor: () => {},
        setEditorText: () => {},
        getEditorText: () => "",
        editor: async () => undefined,
        addAutocompleteProvider: () => {},
        setEditorComponent: () => {},
        getEditorComponent: () => undefined,
        getAllThemes: () => [],
        getTheme: () => undefined,
        setTheme: () => ({ success: true }),
        getToolsExpanded: () => false,
        setToolsExpanded: () => {},
      },
      sessionManager: {} as any,
      modelRegistry: {} as any,
      model: undefined,
      isIdle: () => true,
      signal: undefined,
      abort: () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
    };

    return { commands, sessionStartHandler, toolCallHandler, setStatusCalls, notifyCalls, capture, ctx };
  }

  void it("registers /destructive-confirm-timeout command", () => {
    const { commands } = createFixture();
    assert.ok(commands.has("destructive-confirm-timeout"));
  });

  void it("registers /dc-timeout command", () => {
    const { commands } = createFixture();
    assert.ok(commands.has("dc-timeout"));
  });

  void it("starts with timeout disabled and shows 🔒∞ DC", async () => {
    const { sessionStartHandler, setStatusCalls, ctx } = createFixture();
    await sessionStartHandler!({ type: "session_start", reason: "startup" }, ctx);

    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔒∞ DC");
  });

  void it("toggling timeout changes status to 🔒⏱ DC", async () => {
    const { commands, setStatusCalls, ctx } = createFixture();
    const toggleHandler = commands.get("dc-timeout")!;
    await toggleHandler("", ctx);

    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔒⏱ DC");
  });

  void it("toggling timeout again reverts status to 🔒∞ DC", async () => {
    const { commands, setStatusCalls, ctx } = createFixture();
    const toggleHandler = commands.get("dc-timeout")!;
    await toggleHandler("", ctx); // timeout enabled
    await toggleHandler("", ctx); // back to no timeout

    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔒∞ DC");
  });

  void it("disabling while timeout is on still shows 🔓 DC", async () => {
    const { commands, setStatusCalls, ctx } = createFixture();
    const timeoutHandler = commands.get("dc-timeout")!;
    await timeoutHandler("", ctx); // timeout on → 🔒⏱ DC

    const dcHandler = commands.get("dc")!;
    await dcHandler("", ctx); // protection off → 🔓 DC

    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔓 DC");
  });

  void it("omits timeout from select by default", async () => {
    const { toolCallHandler, capture, ctx } = createFixture();

    await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
      ctx,
    );

    assert.equal(capture.opts?.timeout, undefined);
  });

  void it("passes timeout=CONFIRM_TIMEOUT to select after timeout is toggled on", async () => {
    const { commands, toolCallHandler, capture, ctx } = createFixture();

    const timeoutHandler = commands.get("dc-timeout")!;
    await timeoutHandler("", ctx);

    await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "2" },
      ctx,
    );

    assert.equal(capture.opts?.timeout, CONFIRM_TIMEOUT);
  });

  void it("allow once does not disable protection", async () => {
    const { sessionStartHandler, capture, toolCallHandler, setStatusCalls, notifyCalls, ctx } = createFixture();
    await sessionStartHandler!({ type: "session_start", reason: "startup" }, ctx);

    capture.selectResults = ["Allow once"];

    const result = await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
      ctx,
    );

    // Current action allowed
    assert.equal(result, undefined);

    // Status still shows enabled (session_start set it to 🔒∞ DC)
    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔒∞ DC");

    // No disable notification
    const disableNotif = notifyCalls.find(n => n.message.includes("disabled"));
    assert.equal(disableNotif, undefined);
  });

  void it("allow and disable with explicit second yes disables protection and allows current action", async () => {
    const { sessionStartHandler, capture, toolCallHandler, setStatusCalls, notifyCalls, ctx } = createFixture();
    await sessionStartHandler!({ type: "session_start", reason: "startup" }, ctx);

    capture.selectResults = [
      "Allow and disable protection for this session…",
      "Yes, allow and disable for session",
    ];

    const result = await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
      ctx,
    );

    // Current action allowed
    assert.equal(result, undefined);

    // Status updated to disabled
    const status = setStatusCalls.at(-1);
    assert.equal(status?.text, "🔓 DC");

    // Disable notification shown
    const disableNotif = notifyCalls.find(n => n.message.includes("disabled"));
    assert.notEqual(disableNotif, undefined);
  });

  void it("subsequent destructive calls bypass prompts after session disable", async () => {
    const { capture, toolCallHandler, ctx } = createFixture();

    // First call: allow and disable
    capture.selectResults = [
      "Allow and disable protection for this session…",
      "Yes, allow and disable for session",
    ];

    await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
      ctx,
    );

    assert.equal(capture.selectCalls, 2);

    // Second call: should bypass gate entirely
    const result2 = await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /again" }, toolCallId: "2" },
      ctx,
    );

    // Action allowed without confirmation
    assert.equal(result2, undefined);

    // Select was NOT called again
    assert.equal(capture.selectCalls, 2);
  });

  void it("default no-timeout mode omits timeout for allow and disable flow", async () => {
    const { capture, toolCallHandler, ctx } = createFixture();

    capture.selectResults = [
      "Allow and disable protection for this session…",
      "Yes, allow and disable for session",
    ];

    const result = await toolCallHandler!(
      { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
      ctx,
    );

    // Current action allowed
    assert.equal(result, undefined);

    // Select was called twice and both had no timeout (opts undefined)
    assert.equal(capture.selectCalls, 2);
    assert.equal(capture.opts, undefined);
  });

  // ─── PI_DISABLE_DESTRUCTIVE_CONFIRM env var inheritance ────────────────

  void describe("env var inheritance", () => {
    void it("starts disabled when PI_DISABLE_DESTRUCTIVE_CONFIRM=1 is set", async () => {
      process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM = "1";
      try {
        const { sessionStartHandler, setStatusCalls, toolCallHandler, capture, ctx } = createFixture();
        await sessionStartHandler!({ type: "session_start", reason: "startup" }, ctx);

        // Status shows disabled immediately
        assert.equal(setStatusCalls.at(-1)!.text, "🔓 DC");

        // A destructive call should not be blocked — bypassed before gate
        capture.selectResults = ["Allow once"];
        const result = await toolCallHandler!(
          { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
          ctx,
        );
        assert.equal(result, undefined);

        // Select was never called (gate bypassed by !enabled)
        assert.equal(capture.selectCalls, 0);
      } finally {
        delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      }
    });

    void it("/dc disable sets PI_DISABLE_DESTRUCTIVE_CONFIRM=1", async () => {
      delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      try {
        const { commands, ctx } = createFixture();
        const dcHandler = commands.get("dc")!;
        await dcHandler("", ctx);

        assert.equal(process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM, "1");
      } finally {
        delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      }
    });

    void it("/dc re-enable deletes PI_DISABLE_DESTRUCTIVE_CONFIRM", async () => {
      process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM = "1";
      try {
        const { commands, ctx } = createFixture();
        // Extension starts disabled (from env)
        const dcHandler = commands.get("dc")!;
        // First toggle: disabled → enabled
        await dcHandler("", ctx);

        assert.equal(process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM, undefined);
      } finally {
        delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      }
    });

    void it("dialog disableForSession sets PI_DISABLE_DESTRUCTIVE_CONFIRM=1", async () => {
      delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      try {
        const { capture, toolCallHandler, ctx } = createFixture();
        capture.selectResults = [
          "Allow and disable protection for this session…",
          "Yes, allow and disable for session",
        ];

        await toolCallHandler!(
          { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "1" },
          ctx,
        );

        assert.equal(process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM, "1");
      } finally {
        delete process.env.PI_DISABLE_DESTRUCTIVE_CONFIRM;
      }
    });
  });
});
