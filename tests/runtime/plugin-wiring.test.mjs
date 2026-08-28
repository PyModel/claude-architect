import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = relative => fs.readFileSync(`${root}/${relative}`, "utf8");

describe("P0-A plugin wiring", () => {
  it("ships the runtime, advisor allowlist, protocol marker, and honest support claims", () => {
    const mcp = JSON.parse(read(".mcp.json"));
    assert.deepEqual(mcp, {
      mcpServers: {
        runtime: {
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/runtime/bootstrap.mjs"],
        },
      },
    }, "Claude plugin must register the packaged runtime bootstrap without a shell");
    assert.ok(fs.statSync(`${root}/runtime/bootstrap.mjs`).isFile(), "bootstrap must ship");
    assert.ok(fs.statSync(`${root}/runtime/server.mjs`).isFile(), "server bundle must ship");
    // A bundle rebuilt inside a Producer worktree embeds worktree-relative
    // module paths and diverges from a canonical repo-root build, which is why
    // runtime/server.mjs stays out of Producer write allowlists.
    const bundle = fs.readFileSync(`${root}/runtime/server.mjs`, "utf8");
    assert.ok(
      !/\.\.\/[^"'\n]*node_modules/u.test(bundle),
      "committed bundle must not embed worktree-relative node_modules paths",
    );
    // A literal from one machine's tree cannot catch another contributor's
    // build. The invariant is that NO user-specific absolute path is embedded.
    for (const [shape, pattern] of [
      ["POSIX home", /\/(?:Users|home)\/[^/\s"']+\//u],
      ["Windows home", /[A-Za-z]:\\Users\\[^\\\s"']+\\/u],
    ]) {
      assert.equal(pattern.test(bundle), false,
        `server bundle must not embed a ${shape} absolute path`);
    }
    assert.equal(bundle.includes("/.claude/plugins/"), false,
      "server bundle must not embed a plugin-worktree path");
    for (const autopilotTool of ["autopilotStart", "autopilotStatus", "autopilotResume"]) {
      assert.ok(
        bundle.includes(`"${autopilotTool}"`),
        `server bundle must register ${autopilotTool}`,
      );
    }
    if (process.platform !== "win32") {
      assert.ok(fs.statSync(`${root}/scripts/build-runtime.sh`).mode & 0o111, "build wrapper must be executable");
    }

    const advisor = read("agents/advisor.md");
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(advisor);
    assert.ok(frontmatterMatch, "advisor must have frontmatter");
    const frontmatter = frontmatterMatch[1];
    const keys = new Set([...frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9]*):/gmu)]
      .map(match => match[1]));
    for (const key of ["name", "description", "tools", "model"]) {
      assert.ok(keys.has(key), `advisor must declare ${key}`);
    }
    for (const forbidden of ["mcpServers", "hooks", "permissionMode"]) {
      assert.equal(keys.has(forbidden), false, `advisor must not declare ${forbidden}`);
    }
    const tools = /^tools:\s*(.+)$/mu.exec(frontmatter)?.[1]
      .split(",").map(value => value.trim()) ?? [];
    assert.deepEqual(tools, [
      "Read",
      "Grep",
      "Glob",
      "mcp__plugin_claude-architect_runtime__gitStatus",
      "mcp__plugin_claude-architect_runtime__gitDiff",
      "mcp__plugin_claude-architect_runtime__gitLog",
      "mcp__plugin_claude-architect_runtime__gitChangedFiles",
    ]);
    for (const forbidden of ["Bash", "Write", "Edit"]) {
      assert.equal(tools.includes(forbidden), false, `advisor must exclude ${forbidden}`);
    }

    const versions = read("src/protocol/versions.ts");
    const runtimeProtocol = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/u.exec(versions)?.[1];
    const runtimeVersion = /RUNTIME_VERSION\s*=\s*"([^"]+)"/u.exec(versions)?.[1];
    const skill = read("skills/delegate/SKILL.md");
    const skillProtocol = /^PROTOCOL_VERSION:\s*([^\s]+)$/mu.exec(skill)?.[1];
    assert.equal(runtimeProtocol, "2.0.0", "runtime must expose the current wire protocol");
    assert.equal(
      runtimeVersion,
      JSON.parse(read(".claude-plugin/plugin.json")).version,
      "RUNTIME_VERSION must match the shipped plugin version",
    );
    assert.equal(skillProtocol, runtimeProtocol, "delegate skill protocol marker must match runtime");
    assert.doesNotMatch(skill, /(^|[^:])\/delegate\b/mu, "delegate skill must use the fully qualified command");
    for (const lifecycleTool of ["autopilotStart", "autopilotStatus", "autopilotResume"]) {
      assert.ok(skill.includes(`\`${lifecycleTool}\``), `delegate skill must drive ${lifecycleTool}`);
      assert.match(
        skill,
        new RegExp("[Cc]all `" + lifecycleTool + "`[^\\n]*`checkoutPath`", "u"),
        `delegate skill must pass checkoutPath to ${lifecycleTool}`,
      );
    }
    assert.match(skill, /validationErrors/u, "delegate skill must describe the repair loop");
    assert.match(skill, /protocolVersion/u, "delegate skill must echo its protocol marker");
    assert.match(
      skill,
      /[Cc]all `validateDelegationSpec`[^.\n]*exact Delegation Spec/u,
      "architect must obtain the runtime's canonical spec digest before lane dispatch",
    );
    assert.match(
      skill,
      /Never hash the spec file or reimplement the canonicalization algorithm/u,
      "skill must prohibit the raw-file digest mismatch observed live",
    );
    assert.match(
      skill,
      /Call `delegate`[^.\n]*`expectedSpecSha256`[^.\n]*runtime-returned/u,
      "direct dispatch must bind the spec to the trusted runtime digest",
    );
    assert.match(
      skill,
      /two-call MCP preflight[^.]*`validateDelegationSpec`[^.]*starts no Producer[^.]*exactly one `delegate` or `delegatePipeline`/u,
      "skill must distinguish two MCP calls from two execution attempts",
    );
    assert.match(
      skill,
      /count is MCP calls, not Producer attempts/u,
      "skill must explain Claude Code's grouped runtime call count",
    );
    assert.match(
      skill,
      /plain `delegate` execution run starts exactly one Producer attempt[^.]*`delegatePipeline` run may start multiple fresh Producers/u,
      "skill must not describe a multi-role pipeline as one Producer attempt",
    );
    assert.match(
      skill,
      /execution call is pending[^.]*never invoke `delegate` or `delegatePipeline` again/u,
      "skill must prohibit duplicate dispatch while the original attempt is active",
    );
    assert.doesNotMatch(
      skill,
      /hash you computed/u,
      "review correlation must retain the runtime digest rather than reintroducing caller hashing",
    );
    for (const rosterName of ["codex-implementer", "opencode-implementer", "pi-implementer", "pythinker-implementer", "agy-implementer", "claude-implementer"]) {
      assert.ok(skill.includes(`\`${rosterName}\``), `delegate skill must retain ${rosterName} in its selection roster`);
    }
    const trustedLifecycleHeading = skill.indexOf("## Trusted MCP lifecycle");
    const laneHeading = skill.indexOf("## Lanes as native subagents");
    assert.ok(
      trustedLifecycleHeading >= 0
        && laneHeading > trustedLifecycleHeading
        && !/^## /mu.test(skill.slice(trustedLifecycleHeading + 1, laneHeading)),
      "lane-agent dispatch must immediately follow the trusted MCP lifecycle",
    );
    assert.ok(
      skill.includes("**Same repository**: the runtime serializes all attempts on the repository lock."),
      "skill must state same-repository serialization",
    );
    assert.ok(skill.includes("At most one accepted candidate per clean checkout; never batch-accept multiple candidates targeting the same checkout."));
    assert.ok(skill.includes("runtime-returned `specSha256`"), "skill must document trusted lane correlation");
    assert.match(skill, /laneEligibility\.edit=false/u);
    for (const inventory of [
      "README.md",
      "docs/ARCHITECTURE.md",
      "docs/MARKETPLACE_REVIEW.md",
      "docs/PLUGIN_COMPONENTS.md",
    ]) {
      assert.match(
        read(inventory),
        /validateDelegationSpec/u,
        `${inventory} must inventory the public validation tool`,
      );
    }
    const securityModel = read("docs/SECURITY_MODEL.md");
    assert.match(
      securityModel,
      /MCP elicitation/u,
      "security model must describe the enforced human-decision channel",
    );
    assert.doesNotMatch(
      securityModel,
      /“human-only” is a workflow and UI trust assumption/u,
      "security model must not describe the removed caller-asserted decision path",
    );
    for (const securityDoc of ["docs/MARKETPLACE_REVIEW.md", "docs/THREAT_MODEL.md"]) {
      const contents = read(securityDoc);
      assert.match(
        contents,
        /MCP elicitation/u,
        `${securityDoc} must describe the enforced decision gate`,
      );
      assert.doesNotMatch(
        contents,
        /(?:control of the Claude\/MCP session is the decision credential|a hijacked Claude session can accept)/u,
        `${securityDoc} must distinguish ordinary caller control from trusted-host compromise`,
      );
    }
    const contributing = read("CONTRIBUTING.md");
    assert.match(contributing, /configured decision authority/u,
      "contributor guidance must match the executable acceptance authority");
    assert.doesNotMatch(contributing, /only the human may accept a candidate/u,
      "contributor guidance must not restore unconditional human acceptance");
    // An absence gate whose pattern is an English phrase also matches comments,
    // so a Producer documenting why it avoided the pattern fails a check its
    // code satisfies. Observed live; the rule must stay in the authoring guide.
    assert.match(skill, /A text-search gate must not be able to match prose/u);
    assert.match(skill, /The flag is enforced in both directions/u,
      "skill must document that expectBaselineFailure rejects both non-runs and passes");
    assert.doesNotMatch(skill, /^## Legacy migration fallback$/mu);

    for (const legacyFile of [
      "agents/codex-implementer.md",
      "agents/opencode-implementer.md",
      "agents/pi-implementer.md",
      "agents/pythinker-implementer.md",
      ".opencode/agents/claude-advisor.md",
      ".opencode/agents/codex-implementer.md",
      ".opencode/agents/pi-implementer.md",
      ".opencode/agents/pythinker-implementer.md",
      "scripts/run-isolated.sh",
      "scripts/run-codex-isolated.sh",
      "scripts/run-opencode-isolated.sh",
      "scripts/run-pi-isolated.sh",
      "scripts/run-pythinker-isolated.sh",
      "tests/lane-roster.test.mjs",
      "tests/lane-model-fallback.test.mjs",
      "tests/lane-contract.test.mjs",
      "tests/run-isolated.test.sh",
      "tests/codex-lifecycle.test.sh",
      "tests/runtime/isolated-scripts.test.ts",
    ]) {
      assert.equal(fs.existsSync(`${root}/${legacyFile}`), false, `${legacyFile} must not ship`);
    }

    const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    const readme = read("README.md");
    const changelog = read("CHANGELOG.md");
    assert.equal(plugin.version, "0.49.0");
    assert.equal(marketplace.plugins[0].version, "0.49.0");
    // Derived from plugin.json, not written out: a literal here is a seventh
    // place to edit on every bump, and it is the one that keeps being missed.
    assert.match(readme, new RegExp(`badge/version-${plugin.version.replace(/\./gu, "\\.")}-`, "u"));

    assert.doesNotMatch(
      readme,
      /`\/delegate`/u,
      "README must use the fully qualified public command",
    );
    assert.match(
      changelog,
      new RegExp(`^## \\[${plugin.version.replace(/\./gu, "\\.")}\\]`, "mu"),
      "CHANGELOG must carry a heading for the shipped version",
    );
    assert.match(readme, /macOS arm64[^\n]*certified/iu);
    assert.match(readme, /Linux[^\n]*tested/iu);
    assert.match(readme, /Windows[^\n]*unsupported/iu);
    assert.match(readme, /codex-native-sandbox/u);
    assert.match(marketplace.plugins[0].description, /macOS arm64 certified/iu);
    assert.match(
      marketplace.plugins[0].description,
      /eligible Linux Codex editing is tested; native Windows Codex editing is unsupported/iu,
    );
    assert.match(readme, /Installed marketplace copies[^\n]*update[^\n]*reload/iu);
    assert.match(readme, /--disable multi_agent/u);
    assert.match(readme, /features\.multi_agent_v2=\{enabled=false,max_concurrent_threads_per_session=1\}/u);

    const releaseValidator = read("scripts/validate-release.sh");
    const buildRuntime = read("scripts/build-runtime.sh");
    assert.match(buildRuntime, /npm run build/u, "build wrapper must use the package build contract");
    assert.match(
      releaseValidator,
      /git diff --exit-code -- runtime\/server\.mjs runtime\/bootstrap\.mjs/u,
      "release validation must reject dirty runtime artifacts after rebuilding",
    );
    for (const required of [
      "runtime/bootstrap.mjs",
      "runtime/server.mjs",
      ".mcp.json",
      "PROTOCOL_VERSION",
      "scripts/build-runtime.sh",
    ]) {
      assert.ok(releaseValidator.includes(required), `release validator must check ${required}`);
    }
  });

  it("tracks only the exact shared autopilot MCP permissions", () => {
    const settings = JSON.parse(read(".claude/settings.json"));
    assert.deepEqual(settings, {
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      permissions: {
        allow: [
          "mcp__plugin_claude-architect_runtime__autopilotStart",
          "mcp__plugin_claude-architect_runtime__autopilotStatus",
          "mcp__plugin_claude-architect_runtime__autopilotResume",
        ],
      },
    });
    assert.deepEqual(
      read(".gitignore").split(/\r?\n/u).filter(line => line.startsWith(".claude")),
      [
        ".claude/*",
        ".claude/settings.local.json",
        ".claude/worktrees/",
      ],
    );
    assert.match(read(".gitignore"), /^!\.claude\/settings\.json$/mu);
  });
});

test("subagent-driven-delegation skill keeps the trust invariants that upstream SDD relaxes", () => {
  const sdd = read("skills/subagent-driven-delegation/SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(sdd)?.[1] ?? "";
  assert.match(frontmatter, /^name:\s*subagent-driven-delegation$/mu);
  assert.match(frontmatter, /^description:\s*\S/mu);

  const protocol = /PROTOCOL_VERSION:\s*([^\s]+)/u.exec(sdd)?.[1];
  const runtimeProtocol = /PROTOCOL_VERSION\s*=\s*"([^"]+)"/u
    .exec(read("src/protocol/versions.ts"))?.[1];
  assert.equal(protocol, runtimeProtocol, "SDD skill protocol marker must match runtime");

  // Upstream SDD resumes the implementer, lets the controller close a task, and
  // treats implementer self-review as a gate. Each of those crosses a trust
  // boundary here, so the skill must state the divergence rather than inherit it.
  assert.match(sdd, /No implementer resume/u);
  assert.match(sdd, /controller never marks a task complete/iu);
  assert.match(sdd, /self-review is not a review/iu);
  assert.match(sdd, /controller never fixes findings/iu);

  for (const lifecycleTool of ["reviewCandidate", "decideCandidate", "integrateCandidate"]) {
    assert.ok(sdd.includes(`\`${lifecycleTool}\``), `SDD skill must drive ${lifecycleTool}`);
  }
  assert.match(sdd, /expectedArtifactHash/u, "SDD skill must integrate by artifact hash");
  // Integration stages rather than commits, so without an explicit commit gate
  // the next task's delegate call fails the clean-checkout precondition and the
  // multi-task loop cannot advance past task 1.
  assert.match(sdd, /Gate before the next task/u,
    "SDD skill must gate the next task on a clean checkout after integration");
  assert.match(sdd, /confirm `git status` is clean/u);
  assert.match(sdd, /architect-owned integration workspace/u,
    "SDD must distinguish the branch home from runtime-owned attempt worktrees");
  assert.match(sdd, /delivery gate[^.]*supersedes `superpowers:finishing-a-development-branch`/u,
    "repository delivery policy must override the generic direct merge/push menu");
  assert.match(sdd, /Preserve the plan workspace and branch home while the gate owns the branch/u,
    "SDD must not clean up state still under delivery-gate custody");
  assert.doesNotMatch(sdd, /no-mistakes/iu,
    "the shipped SDD skill must remain generic rather than require a third-party gate");
  // The skill claims to be the native Superpowers SDD surface, so every skill
  // the methodology names must have a stated realization, not just SDD itself.
  for (const upstream of [
    "subagent-driven-development",
    "dispatching-parallel-agents",
    "test-driven-development",
    "systematic-debugging",
    "verification-before-completion",
    "requesting-code-review",
  ]) {
    assert.ok(sdd.includes(`\`${upstream}\``), `SDD skill must map ${upstream}`);
  }
  assert.doesNotMatch(sdd, /(^|[^:])\/subagent-driven-delegation\b/mu,
    "SDD skill must use the fully qualified command");

  const delegate = read("skills/delegate/SKILL.md");
  assert.match(delegate, /\/claude-architect:subagent-driven-delegation/u,
    "delegate skill must point at the SDD skill for multi-task plans");
});

test("project policy composes Superpowers SDD with exclusive delivery controllers", () => {
  const guide = read("AGENTS.md");
  assert.match(guide, /manual SDD[^.]*bare `\/no-mistakes` validate-only mode/u,
    "manual SDD must hand a final committed branch to No Mistakes validate-only mode");
  assert.match(guide, /Autopilot is a separate trusted delivery controller/u,
    "Autopilot must remain distinct from the No Mistakes delivery path");
  assert.match(guide, /Never start or stack No Mistakes while Autopilot is active/u,
    "project policy must prohibit No Mistakes inside Autopilot custody");
  assert.match(guide, /Never start Autopilot while No Mistakes is active/u,
    "project policy must prohibit Autopilot inside No Mistakes custody");
});

test("codex skill ships the direct CLI lane without obscuring its trust boundary", () => {
  const skillPath = `${root}/skills/codex/SKILL.md`;
  assert.equal(fs.existsSync(skillPath), true, "codex skill must ship");
  const skill = read("skills/codex/SKILL.md");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(skill)?.[1] ?? "";
  const keys = [...frontmatter.matchAll(/^([A-Za-z][A-Za-z0-9]*):/gmu)]
    .map(match => match[1]);
  assert.deepEqual(keys, ["name", "description"],
    "codex skill frontmatter must contain only name and description");
  assert.match(frontmatter, /^name:\s*codex$/mu);

  assert.match(skill, /\/claude-architect:codex/u,
    "codex skill must use its plugin-qualified command");
  assert.doesNotMatch(skill, /(^|[^:])\/codex\b/mu,
    "codex skill must never present a bare command");
  assert.match(skill, /default to `gpt-5\.6-sol` at `high`/u,
    "codex skill must retain the current default model and effort");
  assert.match(skill, /Always use --skip-git-repo-check\./u,
    "codex skill must require the repository-check override");
  assert.doesNotMatch(skill, /--full-auto/u,
    "codex skill must use explicit sandbox modes instead of deprecated full-auto");
  assert.doesNotMatch(skill, /2>\/dev\/null/u,
    "codex skill must preserve stderr diagnostics");
  assert.match(
    skill,
    /Capture both streams separately, preserve a nonzero exit as failure,[^.\n]*retaining actionable diagnostics/u,
    "codex skill must retain separate stdout and stderr diagnostics on failure",
  );
  for (const command of [
    "codex exec --skip-git-repo-check --sandbox read-only \"prompt\"",
    "codex exec --skip-git-repo-check --sandbox workspace-write \"prompt\"",
    "codex exec --skip-git-repo-check --sandbox danger-full-access \"prompt\"",
    "codex exec --skip-git-repo-check -C . --sandbox read-only \"prompt\"",
    "codex exec --skip-git-repo-check resume --last \"prompt\"",
  ]) {
    assert.ok(skill.includes(`\`${command}\``), `codex skill must ship ${command}`);
  }
  assert.match(skill, /<\/dev\/null/u,
    "codex skill must document closing stdin for harness invocation");
  assert.match(skill, /POSIX[^]*<\/dev\/null/u,
    "codex skill must document POSIX stdin closure");
  assert.match(skill, /PowerShell[^]*\$null \| codex exec/u,
    "codex skill must document PowerShell stdin closure");
  assert.match(skill, /cmd\.exe[^]*<NUL/u,
    "codex skill must document cmd.exe stdin closure");
  assert.match(skill, /stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/u,
    "codex skill must document portable process stdin closure");
  assert.match(skill, /direct, unverified lane/u,
    "codex skill must identify itself as unverified");
  assert.ok(
    skill.includes("Use `/claude-architect:delegate` for the verified lane"),
    "codex skill must point users to verified delegation");
  assert.match(skill, /Only `\/claude-architect:delegate`[^.]*independently verified/u,
    "codex skill must reserve independent verification for the delegation lane");
  assert.match(skill, /direct skill must never call itself verified/u,
    "codex skill must reject verified-lane claims");
  assert.doesNotMatch(
    skill,
    /(?:direct(?: Codex(?: CLI)?)? lane|direct skill)[^.\n]*\b(?:is|as)\s+(?:independently\s+)?verified\b/iu,
    "codex skill must fail closed on positive verified-lane claims",
  );
  assert.match(
    skill,
    /Before you use high-impact flags[^.\n]*AskUserQuestion[^.\n]*unless it was already given/u,
    "codex skill must require permission before high-impact flags",
  );
  assert.doesNotMatch(skill, /claude-architect-protocol|PROTOCOL_VERSION/u,
    "direct Codex execution must not claim delegation protocol membership");
  assert.doesNotMatch(skill, /isolated production/u,
    "codex skill must use the worktree terminology");

  const readme = read("README.md");
  assert.match(readme, /\/claude-architect:codex/u,
    "README must advertise the plugin-qualified Codex skill");
  assert.doesNotMatch(readme, /(^|[^:])\/codex\b/mu,
    "README must never advertise a bare Codex command");
  assert.match(readme, /direct, unverified Codex CLI lane/u,
    "README must distinguish direct Codex execution from verified delegation");
  assert.match(readme, /isolated worktree/u,
    "README must name the verified lane's isolation boundary");
  assert.match(
    readme,
    /Use `\/claude-architect:delegate`[^.\n]*verified lane[^.\n]*frozen Candidate Artifact/u,
    "README must name the verified lane's canonical frozen artifact",
  );
  assert.doesNotMatch(readme, /isolated production/u,
    "README must not describe a worktree as production");
});

test("CI exercises the supported macOS 15, Ubuntu, and Windows runners", () => {
  const workflow = read(".github/workflows/ci.yml");
  assert.match(
    workflow,
    /os:\s*\[macos-15,\s*ubuntu-latest,\s*windows-latest\]/u,
    "CI must test the approved three-platform runner matrix",
  );
  assert.doesNotMatch(workflow, /macos-14/u);
  assert.match(workflow, /actions\/checkout@v7/u);
  assert.match(workflow, /actions\/setup-node@v7/u);
  assert.match(workflow, /node-version:\s*22/u);
  assert.match(workflow, /actions\/upload-artifact@v7/u);
  assert.match(workflow, /win32-job-kill-x64\.exe/u);
  assert.match(workflow, /setup-zig@v2[^]*version: 0\.15\.2/u,
    "Windows CI must use the pinned compiler that produced the shipped helper");
  assert.match(workflow, /win32-filesystem-x64-reviewed\.exe[^]*fc \/b/u,
    "Windows x64 CI must byte-compare rebuilt and reviewed helper binaries");
  assert.match(workflow, /win32-filesystem-arm64-reviewed\.exe[^]*fc \/b/u,
    "Windows ARM64 CI must byte-compare rebuilt and reviewed filesystem helpers");
  assert.match(workflow, /win32-job-kill-arm64-reviewed\.exe[^]*fc \/b/u,
    "Windows ARM64 CI must byte-compare rebuilt and reviewed process helpers");
  assert.match(workflow, /windows-11-arm/u,
    "Windows ARM64 CI must exercise the shipped arm64 filesystem helper");
  assert.match(workflow, /verify-native-helpers\.mjs/u,
    "CI must verify committed native helper hashes before compiling sources");
  assert.match(workflow, /windows-arm64-filesystem[^]*windows-job-kill\.test\.ts[^]*worktree-manager\.test\.ts[^]*recovery-manager\.test\.ts/u,
    "Windows ARM64 CI must exercise process trees, worktree removal, and startup recovery");
});

test("delegation-lane agent ships the produce-only courier contract", () => {
  const lane = read("agents/delegation-lane.md");
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(lane);
  assert.ok(frontmatterMatch, "delegation-lane must have frontmatter");
  const frontmatter = frontmatterMatch[1];
  const keys = frontmatter.split(/\r?\n/u).map(line => {
    const match = /^([A-Za-z][A-Za-z0-9]*):(?:\s.*)?$/u.exec(line);
    assert.ok(match, `delegation-lane frontmatter must use plain top-level keys: ${line}`);
    return match[1];
  });
  assert.deepEqual(keys.sort(), [
    "name",
    "description",
    "tools",
    "model",
  ].sort(), "delegation-lane must have exactly the permitted frontmatter keys");
  const toolsLine = /^tools:\s*(.+)$/mu.exec(frontmatter)?.[1] ?? "";
  const tools = toolsLine.split(",").map(t => t.trim());
  assert.deepEqual(tools.sort(), [
    "mcp__plugin_claude-architect_runtime__delegate",
    "mcp__plugin_claude-architect_runtime__delegatePipeline",
  ].sort(), "delegation-lane must have exactly the two dispatch tools");
  for (const forbidden of [
    "reviewCandidate", "decideCandidate", "integrateCandidate",
    "Bash", "Write", "Edit", "Read", "Grep", "Glob", "doctor",
  ]) {
    assert.ok(!toolsLine.includes(forbidden), `delegation-lane tools must not include ${forbidden}`);
  }
  // Without this the host offloads an oversized result to a file the lane has
  // no tool to open, so it reports nothing and its controller re-dispatches.
  assert.match(lane, /responseMode: "lane"/u, "lane must request the bounded envelope");
  assert.match(lane, /never re-dispatch a delegation because a result was unreadable/u);
  assert.match(
    lane,
    /complete Delegation Spec is missing[^.]*do not call either MCP tool/u,
    "lane must fail closed instead of inventing a spec from a file-path handoff",
  );
  for (const field of [
    "laneId",
    "specSha256",
    "expectedSpecSha256",
    "\"failure\"",
    "\"error\"",
    "validationErrors",
    "manifestHash",
  ]) {
    assert.ok(lane.includes(field), `delegation-lane contract must include ${field}`);
  }
  assert.match(lane, /[Nn]ever review/u);
  assert.match(frontmatter, /^model:\s*haiku$/mu);
});
