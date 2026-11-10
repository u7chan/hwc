import { describe, expect, test } from "bun:test";
import { createProjectLister, isManifestName, projectEntries, splitGitPaths } from "./projects";

const paths = (...items: string[]) => items.join("\0");

describe("manifest names", () => {
  test("recognizes exact package files", () => {
    for (const name of [
      "package.json",
      "pyproject.toml",
      "setup.py",
      "Cargo.toml",
      "go.mod",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
      "Gemfile",
      "composer.json",
      "Package.swift",
      "pubspec.yaml",
      "mix.exs",
      "deno.json",
      "deno.jsonc",
    ]) {
      expect(isManifestName(name)).toBe(true);
    }
  });

  test("recognizes project-file suffixes", () => {
    expect(isManifestName("Example.gemspec")).toBe(true);
    expect(isManifestName("Example.csproj")).toBe(true);
    expect(isManifestName("Example.fsproj")).toBe(true);
    expect(isManifestName("Example.vbproj")).toBe(true);
  });

  test("does not treat locks, solutions, or build scripts as manifests", () => {
    for (const name of [
      "bun.lock",
      "package-lock.json",
      "pnpm-lock.yaml",
      "Example.sln",
      "CMakeLists.txt",
      "Makefile",
      "flake.nix",
      "requirements.txt",
    ]) {
      expect(isManifestName(name)).toBe(false);
    }
  });
});

describe("project entries", () => {
  test("takes directories with a manifest and removes duplicates", () => {
    expect(
      projectEntries(
        splitGitPaths(
          paths(
            "server/package.json",
            "server/tsconfig.json",
            "client/pyproject.toml",
            "server/Cargo.toml",
          ),
        ),
      ),
    ).toEqual({
      projects: [
        { name: "client", path: "client" },
        { name: "server", path: "server" },
      ],
      truncated: false,
    });
  });

  test("leaves out the working directory itself", () => {
    expect(projectEntries(["package.json", "server/package.json"])).toEqual({
      projects: [{ name: "server", path: "server" }],
      truncated: false,
    });
  });

  test("orders shallower projects first, then by path", () => {
    expect(
      projectEntries([
        "apps/web/package.json",
        "packages/core/package.json",
        "apps/api/package.json",
        "apps/web/packages/ui/package.json",
      ]),
    ).toEqual({
      projects: [
        { name: "api", path: "apps/api" },
        { name: "web", path: "apps/web" },
        { name: "core", path: "packages/core" },
        { name: "ui", path: "apps/web/packages/ui" },
      ],
      truncated: false,
    });
  });

  test("skips generated and dependency directories", () => {
    expect(
      projectEntries([
        "node_modules/example/package.json",
        ".venv/lib/example/pyproject.toml",
        "target/debug/package.json",
        "vendor/example/package.json",
        "dist/package.json",
        "build/package.json",
        "server/package.json",
      ]),
    ).toEqual({
      projects: [{ name: "server", path: "server" }],
      truncated: false,
    });
  });

  test("skips absolute and parent-relative paths", () => {
    expect(
      projectEntries(["/tmp/package.json", "../outside/package.json", "server/package.json"]),
    ).toEqual({
      projects: [{ name: "server", path: "server" }],
      truncated: false,
    });
  });

  test("marks a list over the limit as truncated", () => {
    const files = Array.from(
      { length: 301 },
      (_, index) => `projects/p${String(index).padStart(3, "0")}/package.json`,
    );
    const result = projectEntries(files);
    expect(result.projects).toHaveLength(300);
    expect(result.truncated).toBe(true);
    expect(result.projects[0]).toEqual({ name: "p000", path: "projects/p000" });
    expect(result.projects[299]).toEqual({ name: "p299", path: "projects/p299" });
  });

  test("splits NUL-separated git output without keeping empty entries", () => {
    expect(splitGitPaths("a/package.json\0\0b/pyproject.toml\0")).toEqual([
      "a/package.json",
      "b/pyproject.toml",
    ]);
  });
});

describe("project lister", () => {
  test("shares a result for the same cwd until the TTL expires", async () => {
    let now = 1_000;
    let runs = 0;
    const lister = createProjectLister({
      run: async () => {
        runs += 1;
        return { stdout: "server/package.json", stderr: "", code: 0 };
      },
      now: () => now,
      ttlMs: 100,
    });

    expect(await lister.list({ cwd: "/workspace" })).toEqual({
      projects: [{ name: "server", path: "server" }],
      truncated: false,
    });
    expect(await lister.list({ cwd: "/workspace" })).toEqual({
      projects: [{ name: "server", path: "server" }],
      truncated: false,
    });
    expect(runs).toBe(1);

    now += 101;
    await lister.list({ cwd: "/workspace" });
    expect(runs).toBe(2);
  });

  test("treats a directory outside a git repository as an empty list", async () => {
    const lister = createProjectLister({
      run: async () => ({
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        code: 128,
      }),
    });

    expect(await lister.list({ cwd: "/workspace" })).toEqual({ projects: [], truncated: false });
  });

  test("does not hide a broken repository behind an empty list", async () => {
    const lister = createProjectLister({
      run: async () => ({
        stdout: "",
        stderr: "fatal: index file smaller than expected\n",
        code: 128,
      }),
    });

    await expect(lister.list({ cwd: "/workspace" })).rejects.toThrow("git ls-files failed");
  });

  test("does not hide a timeout behind an empty list", async () => {
    const lister = createProjectLister({
      run: async () => ({ stdout: "", stderr: "", code: 143 }),
    });

    await expect(lister.list({ cwd: "/workspace" })).rejects.toThrow("git ls-files failed");
  });

  test("keeps separate cache entries for different cwds", async () => {
    const lister = createProjectLister({
      run: async (cwd) => ({
        stdout: cwd === "/a" ? "one/package.json" : "two/pyproject.toml",
        stderr: "",
        code: 0,
      }),
    });

    expect((await lister.list({ cwd: "/a" })).projects).toEqual([{ name: "one", path: "one" }]);
    expect((await lister.list({ cwd: "/b" })).projects).toEqual([{ name: "two", path: "two" }]);
  });
});
