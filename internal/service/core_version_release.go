package service

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"
	"time"
)

const coreVersionRepository = "SagerNet/sing-box"
const minimumCoreVersion = "1.14.0"

type coreVersionSource interface {
	List(context.Context, string, string) ([]UpgradeRelease, error)
	Resolve(context.Context, string, string, string) (*UpgradeRelease, error)
	Download(context.Context, string, io.Writer, int64) error
}

type githubCoreVersionSource struct{ *githubUpgradeSource }

func newCoreVersionSource() *githubCoreVersionSource {
	return &githubCoreVersionSource{newGithubUpgradeSource()}
}

type coreGithubRelease struct {
	ID          int64     `json:"id"`
	Tag         string    `json:"tag_name"`
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

func corePackageArchitecture(platform, manager string) string {
	if manager == "apt" {
		switch platform {
		case "amd64", "arm64", "s390x":
			return platform
		case "386":
			return "i386"
		case "armv7":
			return "armhf"
		}
	}
	if manager == "dnf" {
		switch platform {
		case "amd64":
			return "x86_64"
		case "arm64":
			return "aarch64"
		case "s390x":
			return platform
		}
	}
	return ""
}

func coreReleasePackage(release coreGithubRelease, platform, manager string) (*UpgradeRelease, error) {
	version := strings.TrimPrefix(release.Tag, "v")
	comparison, err := compareUpgradeVersions(version, minimumCoreVersion)
	if err != nil || comparison < 0 || release.Draft || release.Prerelease || release.ID < 1 {
		return nil, fmt.Errorf("Select a stable sing-box version %s or newer", minimumCoreVersion)
	}
	if corePackageArchitecture(platform, manager) == "" {
		return nil, fmt.Errorf("This platform has no supported sing-box package")
	}
	name := "sing-box_" + version + "_linux_" + platform + ".deb"
	if manager == "dnf" {
		name = "sing-box_" + version + "_linux_" + corePackageArchitecture(platform, manager) + ".rpm"
	}
	result := &UpgradeRelease{ID: release.ID, Version: version,
		URL: "https://github.com/" + coreVersionRepository + "/releases/tag/" + url.PathEscape(release.Tag), PublishedAt: release.PublishedAt}
	for _, asset := range release.Assets {
		if asset.Name != name {
			continue
		}
		expected := "https://github.com/" + coreVersionRepository + "/releases/download/" + url.PathEscape(release.Tag) + "/" + name
		digest := strings.TrimPrefix(asset.Digest, "sha256:")
		if result.AssetID != 0 || asset.ID < 1 || asset.URL != expected || asset.Size < 1 || asset.Size > 256<<20 || !checksumPattern.MatchString(digest) {
			return nil, fmt.Errorf("The official package has no valid pinned SHA256 digest")
		}
		result.AssetID, result.AssetName, result.AssetURL = asset.ID, name, expected
		result.AssetSize, result.AssetUpdatedAt, result.SHA256 = asset.Size, asset.UpdatedAt, strings.ToLower(digest)
	}
	if result.AssetID == 0 {
		return nil, fmt.Errorf("No official package is available for this platform")
	}
	return result, nil
}

func (source *githubCoreVersionSource) List(ctx context.Context, platform, manager string) ([]UpgradeRelease, error) {
	versions := []UpgradeRelease{}
	seen := map[string]bool{}
	for page := 1; page <= 3; page++ {
		data, err := source.fetch(ctx, fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=30&page=%d", coreVersionRepository, page), 32<<20)
		if err != nil {
			return nil, err
		}
		var releases []coreGithubRelease
		if err := json.Unmarshal(data, &releases); err != nil {
			return nil, err
		}
		pastMinimum := false
		for _, release := range releases {
			if comparison, err := compareUpgradeVersions(release.Tag, minimumCoreVersion); err == nil && comparison < 0 && !release.Prerelease {
				pastMinimum = true
			}
			parsed, err := coreReleasePackage(release, platform, manager)
			if err == nil && !seen[parsed.Version] {
				versions = append(versions, *parsed)
				seen[parsed.Version] = true
			}
		}
		if pastMinimum || len(releases) < 30 {
			break
		}
	}
	sort.Slice(versions, func(i, j int) bool {
		comparison, _ := compareUpgradeVersions(versions[i].Version, versions[j].Version)
		return comparison > 0
	})
	return versions, nil
}

func (source *githubCoreVersionSource) Resolve(ctx context.Context, version, platform, manager string) (*UpgradeRelease, error) {
	version = strings.TrimPrefix(version, "v")
	if comparison, err := compareUpgradeVersions(version, minimumCoreVersion); err != nil || comparison < 0 {
		return nil, fmt.Errorf("Select a stable sing-box version %s or newer", minimumCoreVersion)
	}
	data, err := source.fetch(ctx, "https://api.github.com/repos/"+coreVersionRepository+"/releases/tags/v"+url.PathEscape(version), 4<<20)
	if err != nil {
		return nil, err
	}
	var release coreGithubRelease
	if err := json.Unmarshal(data, &release); err != nil {
		return nil, err
	}
	if strings.TrimPrefix(release.Tag, "v") != version {
		return nil, fmt.Errorf("The release does not match the selected version")
	}
	return coreReleasePackage(release, platform, manager)
}
