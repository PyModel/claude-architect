import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
const marketplace = JSON.parse(fs.readFileSync(new URL("../.claude-plugin/marketplace.json", import.meta.url), "utf8"));
const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
const changelog = fs.readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

assert.equal(typeof manifest.repository, "string", "plugin repository must be a URL string");
assert.equal("bugs" in manifest, false, "plugin manifest must not contain unsupported npm fields");
assert.equal(manifest.name, "claude-architect", "plugin must use the Claude Architect identity");
assert.equal(manifest.displayName, "Claude Architect", "plugin must expose its human-readable name");
assert.equal(marketplace.name, manifest.name, "marketplace and plugin names must match");
assert.equal(marketplace.plugins[0].name, manifest.name, "marketplace entry and plugin names must match");
assert.equal(marketplace.plugins[0].displayName, manifest.displayName, "marketplace display name must match");
assert.equal(marketplace.plugins[0].source, "./", "marketplace must package the repository root");
assert.equal(marketplace.plugins[0].strict, true, "plugin manifest must remain authoritative");
assert.equal(marketplace.renames["claude-master"], manifest.name, "former plugin name must migrate");
assert.equal(
  manifest.repository,
  "https://github.com/PyModel/claude-architect",
  "plugin repository must use the Claude Architect slug",
);
assert.equal(marketplace.plugins[0].repository, manifest.repository, "marketplace repository must match");
assert.equal(marketplace.plugins[0].version, manifest.version, "marketplace and plugin versions must match");
assert.ok(readme.includes(`badge/version-${manifest.version}-`), "README badge must match the plugin version");
assert.ok(changelog.includes(`## [${manifest.version}] -`), "changelog must contain the plugin version");

console.log("PASS: Claude plugin manifest uses the supported schema.");
