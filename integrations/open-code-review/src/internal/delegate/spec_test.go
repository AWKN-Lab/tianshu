package delegate

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestParseNameStatusSupportsRenameAndCopy(t *testing.T) {
	output := []byte("M\x00src/a.ts\x00R100\x00old name.ts\x00new name.ts\x00C100\x00src/a.ts\x00src/copy.ts\x00")
	files, err := parseNameStatus(output)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 || files[1].status != "renamed" || files[2].status != "copied" {
		t.Fatalf("unexpected parsed files: %#v", files)
	}
	if files[1].oldPath == nil || *files[1].oldPath != "old name.ts" {
		t.Fatalf("rename old path was not preserved: %#v", files[1])
	}
}

func TestInspectPatchAndPathValidation(t *testing.T) {
	stats := inspectPatch("diff --git a/a b/a\n@@ -1 +1,2 @@\n-old\n+new\n+next\n")
	if stats.binary || stats.insertions != 2 || stats.deletions != 1 {
		t.Fatalf("unexpected patch statistics: %#v", stats)
	}
	if _, err := safeRepositoryPath("../escape.ts"); err == nil {
		t.Fatal("parent traversal must be rejected")
	}
	if !inspectPatch("diff --git a/a b/a\nGIT binary patch\nliteral 1\n").binary {
		t.Fatal("binary patch must be detected")
	}
}

func TestGenerateProducesStableContentBoundSpec(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is unavailable")
	}
	repository := t.TempDir()
	runGit(t, repository, "init")
	runGit(t, repository, "config", "user.email", "review-kernel@example.invalid")
	runGit(t, repository, "config", "user.name", "Review Kernel Test")
	writeTestFile(t, repository, "src/a.ts", "export const value = 1;\n")
	runGit(t, repository, "add", "src/a.ts")
	runGit(t, repository, "commit", "-m", "base")
	base := strings.TrimSpace(runGit(t, repository, "rev-parse", "HEAD"))
	writeTestFile(t, repository, "src/a.ts", "export const value = 2;\n")
	writeTestFile(t, repository, "tests/中文 case.test.ts", "export const covered = true;\n")
	runGit(t, repository, "add", ".")
	runGit(t, repository, "commit", "-m", "head")
	head := strings.TrimSpace(runGit(t, repository, "rev-parse", "HEAD"))

	first, err := Generate(repository, base, head, "test-awkn.1")
	if err != nil {
		t.Fatal(err)
	}
	second, err := Generate(repository, base, head, "test-awkn.1")
	if err != nil {
		t.Fatal(err)
	}
	if first.DiffFingerprint != second.DiffFingerprint || first.RuleBundleHash != second.RuleBundleHash {
		t.Fatal("identical repository state did not produce stable fingerprints")
	}
	if first.Schema != protocolSchema || first.Target.FromOID != base || first.Target.ToOID != head {
		t.Fatalf("unexpected target: %#v", first.Target)
	}
	if first.Summary.TotalFiles != 2 || first.Summary.ReviewableFiles != 2 || len(first.Files) != 2 {
		t.Fatalf("unexpected coverage summary: %#v", first.Summary)
	}
	if first.Files[1].Path != "tests/中文 case.test.ts" || !first.Files[1].WillReview {
		t.Fatalf("test and Unicode path must be reviewable: %#v", first.Files[1])
	}
}

func runGit(t *testing.T, repository string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = repository
	if runtime.GOOS == "windows" {
		command.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1")
	}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}

func writeTestFile(t *testing.T, repository, relative, content string) {
	t.Helper()
	path := filepath.Join(repository, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
