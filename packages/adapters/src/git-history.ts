import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence } from "@testknowledge/model";
import type { ProjectEvidenceProvider, ProjectScope } from "@testknowledge/core";

const FIX_SIGNAL = /\b(fix(?:ed|es)?|bug|regression|defect|hotfix)\b|修复|回归|缺陷|故障/iu;
const TEST_PATH = /(?:^|\/)(?:test|tests)(?:\/|$)|(?:^|\/)src\/test(?:\/|$)|(?:^|\/)test_[^/]+\.py$|_test\.py$|_test\.go$|(?:Test|Tests|IT)\.java$/iu;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function gitLog(repo: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, "log", "-n", "100", "--date=iso-strict", "--pretty=format:%x1e%H%x1f%aI%x1f%s%x1f%b%x1f", "--name-only"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 5 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export class GitHistoryEvidenceProvider implements ProjectEvidenceProvider {
  readonly id = "source.git-history.v2";

  async collect(scope: ProjectScope): Promise<Evidence[]> {
    await access(join(scope.repo, ".git"));
    const extractedAt = new Date().toISOString();
    const evidence: Evidence[] = [];
    for (const record of (await gitLog(scope.repo)).split("\x1e").slice(1)) {
      const [commitId, committedAt, subject, body, fileBlock = ""] = record.split("\x1f");
      if (!commitId || !subject || !FIX_SIGNAL.test(`${subject}\n${body ?? ""}`)) continue;
      const changedFiles = fileBlock.split(/\r?\n/u).map((path) => path.trim()).filter(Boolean);
      const testFiles = changedFiles.filter((path) => TEST_PATH.test(path));
      const productionFiles = changedFiles.filter((path) => !TEST_PATH.test(path));
      const content = [subject, body ?? ""].filter(Boolean).join("\n");
      evidence.push({
        id: `ev_${hash(`${scope.repo}:${commitId}:${hash(content)}`).slice(0, 24)}`,
        sourceType: "bug_history",
        sourceRef: `git:${commitId}`,
        repo: scope.repo,
        revision: scope.revision,
        path: `.git/commits/${commitId}`,
        symbol: "",
        lineStart: 1,
        lineEnd: 1,
        contentHash: hash(content),
        extractedAt,
        extractor: this.id,
        content,
        confidence: testFiles.length > 0 ? 0.9 : 0.75,
        payload: { commitId, committedAt: committedAt ?? "", subject, body: body ?? "", changedFiles, testFiles, productionFiles },
      });
    }
    return evidence;
  }
}
