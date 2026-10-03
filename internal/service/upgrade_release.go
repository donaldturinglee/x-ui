package service

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const upgradeRepository = "donaldturinglee/x-ui"

var stableVersion = regexp.MustCompile(`^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`)
var checksumPattern = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

func compareUpgradeVersions(current, target string) (int, error) {
	a, b := stableVersion.FindStringSubmatch(current), stableVersion.FindStringSubmatch(target)
	if a == nil || b == nil {
		return 0, fmt.Errorf("Automatic upgrade requires stable semantic versions")
	}
	comparison := 0
	for i := 1; i <= 3; i++ {
		x, err := strconv.ParseUint(a[i], 10, 64)
		if err != nil {
			return 0, err
		}
		y, err := strconv.ParseUint(b[i], 10, 64)
		if err != nil {
			return 0, err
		}
		if comparison == 0 && x < y {
			comparison = -1
		}
		if comparison == 0 && x > y {
			comparison = 1
		}
	}
	return comparison, nil
}

func releasePlatform(machine string) (string, error) {
	switch {
	case machine == "x86_64" || machine == "amd64" || machine == "x64":
		return "amd64", nil
	case machine == "386" || machine == "x86" || regexp.MustCompile(`^i[3-6]86$`).MatchString(machine):
		return "386", nil
	case machine == "aarch64" || machine == "arm64" || strings.HasPrefix(machine, "armv8"):
		return "arm64", nil
	case machine == "arm" || strings.HasPrefix(machine, "armv7"):
		return "armv7", nil
	case strings.HasPrefix(machine, "armv6"):
		return "armv6", nil
	case strings.HasPrefix(machine, "armv5"):
		return "armv5", nil
	case machine == "s390x":
		return "s390x", nil
	default:
		return "", fmt.Errorf("This CPU architecture has no x-ui release package")
	}
}

type UpgradeRelease struct {
	ID             int64     `json:"id"`
	Version        string    `json:"version"`
	URL            string    `json:"url"`
	PublishedAt    time.Time `json:"publishedAt"`
	AssetID        int64     `json:"assetId"`
	AssetName      string    `json:"assetName"`
	AssetURL       string    `json:"assetUrl"`
	AssetSize      int64     `json:"assetSize"`
	AssetUpdatedAt time.Time `json:"assetUpdatedAt"`
	SHA256         string    `json:"sha256"`
}

type upgradeReleaseSource interface {
	Latest(context.Context, string) (*UpgradeRelease, error)
	Resolve(context.Context, int64, string) (*UpgradeRelease, error)
	Download(context.Context, string, io.Writer, int64) error
}

type githubUpgradeSource struct{ client *http.Client }

func newGithubUpgradeSource() *githubUpgradeSource {
	return &githubUpgradeSource{client: &http.Client{
		Timeout: 15 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 || !trustedReleaseURL(request.URL) {
				return fmt.Errorf("Untrusted release redirect")
			}
			return nil
		},
	}}
}

func trustedReleaseURL(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	host := strings.ToLower(u.Hostname())
	return host == "api.github.com" || host == "github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

func (source *githubUpgradeSource) fetch(ctx context.Context, address string, limit int64) ([]byte, error) {
	var output strings.Builder
	if err := source.Download(ctx, address, &output, limit); err != nil {
		return nil, err
	}
	return []byte(output.String()), nil
}

func (source *githubUpgradeSource) Download(ctx context.Context, address string, target io.Writer, limit int64) error {
	u, err := url.Parse(address)
	if err != nil || !trustedReleaseURL(u) {
		return fmt.Errorf("Untrusted release URL")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "x-ui-upgrade")
	response, err := source.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("GitHub returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > limit {
		return fmt.Errorf("Release download exceeds the size limit")
	}
	n, err := io.Copy(target, io.LimitReader(response.Body, limit+1))
	if err != nil {
		return err
	}
	if n > limit {
		return fmt.Errorf("Release download exceeds the size limit")
	}
	return nil
}

func (source *githubUpgradeSource) Latest(ctx context.Context, platform string) (*UpgradeRelease, error) {
	return source.release(ctx, "latest", platform)
}

func (source *githubUpgradeSource) Resolve(ctx context.Context, id int64, platform string) (*UpgradeRelease, error) {
	return source.release(ctx, strconv.FormatInt(id, 10), platform)
}

func (source *githubUpgradeSource) release(ctx context.Context, selector, platform string) (*UpgradeRelease, error) {
	data, err := source.fetch(ctx, "https://api.github.com/repos/"+upgradeRepository+"/releases/"+selector, 4<<20)
	if err != nil {
		return nil, err
	}
	var release struct {
		ID          int64     `json:"id"`
		Tag         string    `json:"tag_name"`
		URL         string    `json:"html_url"`
		PublishedAt time.Time `json:"published_at"`
		Draft       bool      `json:"draft"`
		Prerelease  bool      `json:"prerelease"`
		Assets      []struct {
			ID        int64     `json:"id"`
			Name      string    `json:"name"`
			URL       string    `json:"browser_download_url"`
			Size      int64     `json:"size"`
			UpdatedAt time.Time `json:"updated_at"`
			Digest    string    `json:"digest"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(data, &release); err != nil {
		return nil, err
	}
	if release.ID < 1 || release.Draft || release.Prerelease || !stableVersion.MatchString(release.Tag) {
		return nil, fmt.Errorf("No stable release is available")
	}
	result := &UpgradeRelease{ID: release.ID, Version: release.Tag, URL: "https://github.com/" + upgradeRepository + "/releases/tag/" + url.PathEscape(release.Tag), PublishedAt: release.PublishedAt}
	assetName := "x-ui-linux-" + platform + ".tar.gz"
	checksums := ""
	digest := ""
	for _, asset := range release.Assets {
		if asset.Name != assetName && asset.Name != "SHA256SUMS" {
			continue
		}
		expected := "https://github.com/" + upgradeRepository + "/releases/download/" + url.PathEscape(release.Tag) + "/" + asset.Name
		if asset.ID < 1 || asset.URL != expected {
			return nil, fmt.Errorf("Invalid release asset")
		}
		if asset.Name == "SHA256SUMS" {
			if checksums != "" {
				return nil, fmt.Errorf("Duplicate checksum asset")
			}
			checksums = asset.URL
		} else {
			if result.AssetID != 0 || asset.Size <= 0 || asset.Size > 1<<30 {
				return nil, fmt.Errorf("Invalid release package")
			}
			result.AssetID, result.AssetName, result.AssetURL, result.AssetSize, result.AssetUpdatedAt = asset.ID, asset.Name, asset.URL, asset.Size, asset.UpdatedAt
			digest = strings.TrimPrefix(asset.Digest, "sha256:")
		}
	}
	if checksums == "" || result.AssetID == 0 {
		return nil, fmt.Errorf("Release package or SHA256SUMS is missing")
	}
	data, err = source.fetch(ctx, checksums, 1<<20)
	if err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == assetName {
			if result.SHA256 != "" || !checksumPattern.MatchString(fields[0]) {
				return nil, fmt.Errorf("Invalid package checksum")
			}
			result.SHA256 = strings.ToLower(fields[0])
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if result.SHA256 == "" || digest != "" && (!checksumPattern.MatchString(digest) || !strings.EqualFold(digest, result.SHA256)) {
		return nil, fmt.Errorf("Release checksums do not agree")
	}
	return result, nil
}
