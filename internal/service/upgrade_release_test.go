package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

type upgradeRoundTrip func(*http.Request) (*http.Response, error)

func (transport upgradeRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestGithubUpgradeSourcePinsRepositoryAndRequiresMatchingChecksum(t *testing.T) {
	for _, kind := range []string{"valid", "missing", "duplicate", "digest", "external", "prerelease"} {
		t.Run(kind, func(t *testing.T) {
			sum := strings.Repeat("a", 64)
			asset := "https://github.com/" + upgradeRepository + "/releases/download/v1.2.3/x-ui-linux-armv6.tar.gz"
			if kind == "external" {
				asset = "https://other.example/package.tar.gz"
			}
			digest := "sha256:" + sum
			if kind == "digest" {
				digest = "sha256:" + strings.Repeat("b", 64)
			}
			body, _ := json.Marshal(map[string]any{"id": 7, "tag_name": "v1.2.3", "prerelease": kind == "prerelease", "assets": []map[string]any{{"id": 8, "name": "x-ui-linux-armv6.tar.gz", "browser_download_url": asset, "size": 100, "digest": digest}, {"id": 9, "name": "SHA256SUMS", "browser_download_url": "https://github.com/" + upgradeRepository + "/releases/download/v1.2.3/SHA256SUMS"}}})
			source := newGithubUpgradeSource()
			requests := 0
			source.client.Transport = upgradeRoundTrip(func(request *http.Request) (*http.Response, error) {
				requests++
				if request.URL.Hostname() != "api.github.com" && request.URL.Hostname() != "github.com" {
					t.Fatal("unexpected request", request.URL)
				}
				responseBody := string(body)
				if strings.HasSuffix(request.URL.Path, "SHA256SUMS") {
					responseBody = sum + "  x-ui-linux-armv6.tar.gz\n"
					if kind == "missing" {
						responseBody = sum + "  x-ui-linux-amd64.tar.gz\n"
					}
					if kind == "duplicate" {
						responseBody += responseBody
					}
				} else if request.URL.Path != "/repos/"+upgradeRepository+"/releases/latest" {
					t.Fatal("repository not pinned", request.URL)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(responseBody)), Header: http.Header{}}, nil
			})
			release, err := source.Latest(context.Background(), "armv6")
			if kind == "valid" {
				if err != nil || release.AssetID != 8 || release.SHA256 != sum || requests != 2 {
					t.Fatal(release, err, requests)
				}
			} else if err == nil {
				t.Fatal("invalid release accepted", kind)
			}
		})
	}
}

func TestUpgradeDownloadRejectsUntrustedRedirectsAndOversizedBodies(t *testing.T) {
	source := newGithubUpgradeSource()
	for _, address := range []string{"http://github.com/file", "https://localhost/file", "https://github.com:8443/file", "https://github.com.evil.example/file", "https://user@github.com/file"} {
		parsed, _ := url.Parse(address)
		if err := source.client.CheckRedirect(&http.Request{URL: parsed}, nil); err == nil {
			t.Fatal(address)
		}
	}
	source.client.Transport = upgradeRoundTrip(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ContentLength: -1, Body: io.NopCloser(strings.NewReader("too big")), Header: http.Header{}}, nil
	})
	if err := source.Download(context.Background(), "https://github.com/file", io.Discard, 3); err == nil {
		t.Fatal("oversized download accepted")
	}
}
