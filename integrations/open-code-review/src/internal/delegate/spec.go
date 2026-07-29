package delegate

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

const (
	protocolSchema = "ocr-delegate-spec/v1"
	baselineRule   = "Review the frozen diff for correctness, contracts, regressions, test quality, and security. Report only evidence-backed findings."
)

type Repository struct {
	Root string `json:"root"`
}

type Target struct {
	Mode         string `json:"mode"`
	FromRef      string `json:"from_ref"`
	FromOID      string `json:"from_oid"`
	ToRef        string `json:"to_ref"`
	ToOID        string `json:"to_oid"`
	MergeBaseOID string `json:"merge_base_oid"`
}

type Summary struct {
	TotalFiles       int `json:"total_files"`
	ReviewableFiles  int `json:"reviewable_files"`
	ExcludedFiles    int `json:"excluded_files"`
	TotalInsertions  int `json:"total_insertions"`
	TotalDeletions   int `json:"total_deletions"`
}

type File struct {
	Path            string  `json:"path"`
	OldPath         *string `json:"old_path"`
	Status          string  `json:"status"`
	Insertions      int     `json:"insertions"`
	Deletions       int     `json:"deletions"`
	WillReview      bool    `json:"will_review"`
	ExcludeReason   *string `json:"exclude_reason"`
	RuleGroupID     int     `json:"rule_group_id"`
	DiffFingerprint string  `json:"diff_fingerprint"`
}

type RuleGroup struct {
	ID          int      `json:"id"`
	Source      string   `json:"source"`
	Pattern     string   `json:"pattern"`
	ContentHash string   `json:"content_hash"`
	Rule        string   `json:"rule"`
	Files       []string `json:"files"`
}

type Spec struct {
	Schema           string       `json:"schema"`
	OCRVersion       string       `json:"ocr_version"`
	Repository       Repository   `json:"repository"`
	Target           Target       `json:"target"`
	DiffFingerprint  string       `json:"diff_fingerprint"`
	RuleBundleHash   string       `json:"rule_bundle_hash"`
	Summary          Summary      `json:"summary"`
	Files            []File       `json:"files"`
	RuleGroups       []RuleGroup  `json:"rule_groups"`
}

type changedPath struct {
	path    string
	oldPath *string
	status  string
}

type patchStatistics struct {
	insertions int
	deletions  int
	binary     bool
}

func Generate(repository, fromRef, toRef, version string) (Spec, error) {
	if version == "" {
		return Spec{}, errors.New("OCR version is required")
	}
	root, err := filepath.Abs(repository)
	if err != nil {
		return Spec{}, fmt.Errorf("resolve repository: %w", err)
	}
	root = filepath.Clean(root)
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return Spec{}, fmt.Errorf("resolve real repository path: %w", err)
	}
	topLevel, err := git(root, "rev-parse", "--show-toplevel")
	if err != nil {
		return Spec{}, err
	}
	resolvedTop, err := filepath.Abs(strings.TrimSpace(string(topLevel)))
	if err != nil {
		return Spec{}, fmt.Errorf("resolve Git top-level: %w", err)
	}
	realTop, err := filepath.EvalSymlinks(filepath.Clean(resolvedTop))
	if err != nil {
		return Spec{}, fmt.Errorf("resolve real Git top-level: %w", err)
	}
	if !samePath(filepath.Clean(realRoot), filepath.Clean(realTop)) {
		return Spec{}, fmt.Errorf("repository must be the Git top-level: %s", strings.TrimSpace(string(topLevel)))
	}

	fromOID, err := resolveCommit(root, fromRef)
	if err != nil {
		return Spec{}, fmt.Errorf("resolve from ref: %w", err)
	}
	toOID, err := resolveCommit(root, toRef)
	if err != nil {
		return Spec{}, fmt.Errorf("resolve to ref: %w", err)
	}
	mergeBaseBytes, err := git(root, "merge-base", fromOID, toOID)
	if err != nil {
		return Spec{}, fmt.Errorf("resolve merge-base: %w", err)
	}
	mergeBase := strings.TrimSpace(string(mergeBaseBytes))
	if !validOID(mergeBase) {
		return Spec{}, errors.New("merge-base returned an invalid object ID")
	}

	nameStatus, err := git(root, "diff", "--name-status", "-z", "-M", "-C", mergeBase, toOID)
	if err != nil {
		return Spec{}, err
	}
	changed, err := parseNameStatus(nameStatus)
	if err != nil {
		return Spec{}, err
	}
	sort.Slice(changed, func(i, j int) bool { return changed[i].path < changed[j].path })

	files := make([]File, 0, len(changed))
	summary := Summary{TotalFiles: len(changed)}
	for _, item := range changed {
		patchBytes, err := git(root, "diff", "--binary", "--no-ext-diff", mergeBase, toOID, "--", item.path)
		if err != nil {
			return Spec{}, fmt.Errorf("read patch for %s: %w", item.path, err)
		}
		patch := string(patchBytes)
		stats := inspectPatch(patch)
		status := item.status
		var excludeReason *string
		willReview := true
		if stats.binary {
			status = "binary"
			willReview = false
			excludeReason = stringPointer("binary")
		} else if generatedPath(item.path) {
			willReview = false
			excludeReason = stringPointer("provider_default_path")
		}
		fingerprint, err := fileFingerprint(item, patch, stats)
		if err != nil {
			return Spec{}, err
		}
		files = append(files, File{
			Path: item.path, OldPath: item.oldPath, Status: status,
			Insertions: stats.insertions, Deletions: stats.deletions,
			WillReview: willReview, ExcludeReason: excludeReason,
			RuleGroupID: 0, DiffFingerprint: "sha256:" + fingerprint,
		})
		summary.TotalInsertions += stats.insertions
		summary.TotalDeletions += stats.deletions
		if willReview {
			summary.ReviewableFiles++
		} else {
			summary.ExcludedFiles++
		}
	}

	ruleText, source, err := loadRuleBundle(root, toOID)
	if err != nil {
		return Spec{}, err
	}
	paths := make([]string, 0, len(files))
	for _, file := range files {
		paths = append(paths, file.Path)
	}
	rules := []RuleGroup{{
		ID: 0, Source: source, Pattern: "**", Rule: ruleText,
		ContentHash: prefixedHash([]byte(ruleText)), Files: paths,
	}}
	ruleJSON, err := jsonBytes(rules)
	if err != nil {
		return Spec{}, fmt.Errorf("hash rules: %w", err)
	}
	diffFingerprint, err := aggregateFingerprint(fromOID, toOID, mergeBase, files)
	if err != nil {
		return Spec{}, err
	}
	return Spec{
		Schema: protocolSchema,
		OCRVersion: version,
		Repository: Repository{Root: root},
		Target: Target{
			Mode: "range", FromRef: fromRef, FromOID: fromOID,
			ToRef: toRef, ToOID: toOID, MergeBaseOID: mergeBase,
		},
		DiffFingerprint: "sha256:" + diffFingerprint,
		RuleBundleHash: prefixedHash(ruleJSON),
		Summary: summary,
		Files: files,
		RuleGroups: rules,
	}, nil
}

func git(root string, args ...string) ([]byte, error) {
	commandArgs := append([]string{"-c", "core.quotepath=false"}, args...)
	command := exec.Command("git", commandArgs...)
	command.Dir = root
	command.Env = safeGitEnvironment(os.Environ())
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("git %s failed: %s", args[0], message)
	}
	return stdout.Bytes(), nil
}

func safeGitEnvironment(environment []string) []string {
	allowed := map[string]bool{
		"PATH": true, "PATHEXT": true, "SYSTEMROOT": true, "WINDIR": true,
		"COMSPEC": true, "TEMP": true, "TMP": true, "TMPDIR": true,
		"HOME": true, "USERPROFILE": true, "LOCALAPPDATA": true,
		"LANG": true, "LC_ALL": true,
	}
	result := make([]string, 0, len(environment)+3)
	for _, entry := range environment {
		key, _, found := strings.Cut(entry, "=")
		if found && allowed[strings.ToUpper(key)] {
			result = append(result, entry)
		}
	}
	return append(result,
		"GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull,
		"GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0",
	)
}

func resolveCommit(root, ref string) (string, error) {
	if strings.HasPrefix(ref, "-") || strings.ContainsRune(ref, 0) {
		return "", errors.New("unsafe Git reference")
	}
	output, err := git(root, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", err
	}
	oid := strings.TrimSpace(string(output))
	if !validOID(oid) {
		return "", errors.New("Git returned an invalid object ID")
	}
	return oid, nil
}

func validOID(value string) bool {
	if len(value) != 40 {
		return false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}

func parseNameStatus(output []byte) ([]changedPath, error) {
	tokens := bytes.Split(output, []byte{0})
	if len(tokens) > 0 && len(tokens[len(tokens)-1]) == 0 {
		tokens = tokens[:len(tokens)-1]
	}
	files := make([]changedPath, 0, len(tokens)/2)
	for index := 0; index < len(tokens); {
		code := string(tokens[index])
		index++
		if code == "" {
			return nil, errors.New("malformed empty Git status")
		}
		if strings.HasPrefix(code, "R") || strings.HasPrefix(code, "C") {
			if index+1 >= len(tokens) {
				return nil, errors.New("malformed Git rename/copy output")
			}
			oldPath, err := safeRepositoryPath(string(tokens[index]))
			if err != nil {
				return nil, err
			}
			path, err := safeRepositoryPath(string(tokens[index+1]))
			if err != nil {
				return nil, err
			}
			index += 2
			files = append(files, changedPath{path: path, oldPath: stringPointer(oldPath), status: statusFromCode(code)})
			continue
		}
		if index >= len(tokens) {
			return nil, errors.New("malformed Git name-status output")
		}
		path, err := safeRepositoryPath(string(tokens[index]))
		if err != nil {
			return nil, err
		}
		index++
		files = append(files, changedPath{path: path, status: statusFromCode(code)})
	}
	return files, nil
}

func statusFromCode(code string) string {
	upper := strings.ToUpper(code)
	switch {
	case strings.HasPrefix(upper, "R"):
		return "renamed"
	case strings.HasPrefix(upper, "C"):
		return "copied"
	case strings.Contains(upper, "D"):
		return "deleted"
	case strings.Contains(upper, "A"):
		return "added"
	default:
		return "modified"
	}
}

func safeRepositoryPath(value string) (string, error) {
	path := strings.ReplaceAll(filepath.ToSlash(value), "\\", "/")
	if path == "" || strings.HasPrefix(path, "/") || filepath.IsAbs(value) || strings.ContainsRune(path, 0) {
		return "", fmt.Errorf("unsafe repository path: %q", value)
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("unsafe repository path: %q", value)
		}
	}
	return path, nil
}

func inspectPatch(patch string) patchStatistics {
	if strings.Contains(patch, "\nGIT binary patch\n") || strings.Contains(patch, "\nBinary files ") {
		return patchStatistics{binary: true}
	}
	statistics := patchStatistics{}
	for _, line := range strings.Split(patch, "\n") {
		if strings.HasPrefix(line, "+") && !strings.HasPrefix(line, "+++") {
			statistics.insertions++
		}
		if strings.HasPrefix(line, "-") && !strings.HasPrefix(line, "---") {
			statistics.deletions++
		}
	}
	return statistics
}

func fileFingerprint(item changedPath, patch string, stats patchStatistics) (string, error) {
	payload := struct {
		OldPath    *string `json:"old_path"`
		Path       string  `json:"path"`
		Status     string  `json:"status"`
		Insertions int     `json:"insertions"`
		Deletions  int     `json:"deletions"`
		Binary     bool    `json:"binary"`
		Diff       string  `json:"diff"`
	}{item.oldPath, item.path, item.status, stats.insertions, stats.deletions, stats.binary, patch}
	encoded, err := jsonBytes(payload)
	if err != nil {
		return "", fmt.Errorf("hash file %s: %w", item.path, err)
	}
	return hash(encoded), nil
}

func aggregateFingerprint(fromOID, toOID, mergeBase string, files []File) (string, error) {
	projection := make([]struct {
		Path            string `json:"path"`
		DiffFingerprint string `json:"diff_fingerprint"`
	}, 0, len(files))
	for _, file := range files {
		projection = append(projection, struct {
			Path            string `json:"path"`
			DiffFingerprint string `json:"diff_fingerprint"`
		}{file.Path, file.DiffFingerprint})
	}
	payload := struct {
		FromOID      string `json:"from_oid"`
		ToOID        string `json:"to_oid"`
		MergeBaseOID string `json:"merge_base_oid"`
		Files        any    `json:"files"`
	}{fromOID, toOID, mergeBase, projection}
	encoded, err := jsonBytes(payload)
	if err != nil {
		return "", fmt.Errorf("hash aggregate diff: %w", err)
	}
	return hash(encoded), nil
}

func loadRuleBundle(root, toOID string) (string, string, error) {
	candidates := []string{".opencodereview.md", "AGENTS.md", filepath.Join(".github", "copilot-instructions.md")}
	parts := make([]string, 0, len(candidates))
	source := "system"
	for _, relative := range candidates {
		posixRelative := filepath.ToSlash(relative)
		entry, err := git(root, "ls-tree", "-z", "--name-only", toOID, "--", posixRelative)
		if err != nil {
			return "", "", fmt.Errorf("locate review rule %s: %w", posixRelative, err)
		}
		if len(entry) == 0 {
			continue
		}
		content, err := git(root, "show", toOID+":"+posixRelative)
		if err != nil {
			return "", "", fmt.Errorf("read review rule %s: %w", posixRelative, err)
		}
		if bytes.IndexByte(content, 0) >= 0 {
			return "", "", fmt.Errorf("review rule %s is binary", filepath.ToSlash(relative))
		}
		parts = append(parts, "# "+posixRelative+"\n"+strings.ReplaceAll(string(content), "\r\n", "\n"))
		source = "project"
	}
	if len(parts) == 0 {
		return baselineRule, source, nil
	}
	return strings.Join(parts, "\n\n"), source, nil
}

var generatedPattern = regexp.MustCompile(`(?i)(^|/)(dist|build|coverage|vendor|node_modules)(/|$)|\.min\.[^/]+$`)

func generatedPath(path string) bool { return generatedPattern.MatchString(path) }

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(left, right)
	}
	return left == right
}

func stringPointer(value string) *string { return &value }

func jsonBytes(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte{'\n'}), nil
}

func hash(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func prefixedHash(value []byte) string { return "sha256:" + hash(value) }
