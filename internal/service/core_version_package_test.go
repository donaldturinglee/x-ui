package service

import (
	"archive/tar"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCoreVersionTarExtractsOnlyRegularExpectedExecutable(t *testing.T) {
	for _, invalid := range []string{"", "traversal", "symlink", "duplicate", "missing"} {
		t.Run(invalid, func(t *testing.T) {
			var data bytes.Buffer
			writer := tar.NewWriter(&data)
			_ = writer.WriteHeader(&tar.Header{Name: "./", Typeflag: tar.TypeDir, Mode: 0755})
			header := tar.Header{Name: "./usr/bin/sing-box", Mode: 0755, Size: 4, Typeflag: tar.TypeReg}
			if invalid == "traversal" {
				header.Name = "../usr/bin/sing-box"
			}
			if invalid == "symlink" {
				header.Typeflag, header.Linkname, header.Size = tar.TypeSymlink, "/tmp/evil", 0
			}
			if invalid == "missing" {
				header.Name = "./usr/bin/other"
			}
			_ = writer.WriteHeader(&header)
			if header.Size > 0 {
				_, _ = writer.Write([]byte("core"))
			}
			if invalid == "duplicate" {
				_ = writer.WriteHeader(&header)
				_, _ = writer.Write([]byte("core"))
			}
			_ = writer.Close()
			target := filepath.Join(t.TempDir(), "candidate")
			err := extractCoreTar(&data, target)
			if (err != nil) != (invalid != "") {
				t.Fatal("unexpected extraction result", invalid, err)
			}
			if invalid == "" {
				content, _ := os.ReadFile(target)
				if string(content) != "core" {
					t.Fatal(string(content))
				}
			}
		})
	}
}

func coreCPIOEntry(name string, mode uint32, content string) []byte {
	name += "\x00"
	fields := []uint32{1, mode, 0, 0, 1, 0, uint32(len(content)), 0, 0, 0, 0, uint32(len(name)), 0}
	var data bytes.Buffer
	data.WriteString("070701")
	for _, field := range fields {
		fmt.Fprintf(&data, "%08x", field)
	}
	data.WriteString(name)
	for data.Len()%4 != 0 {
		data.WriteByte(0)
	}
	data.WriteString(content)
	for data.Len()%4 != 0 {
		data.WriteByte(0)
	}
	return data.Bytes()
}

func TestCoreVersionRPMExtractsNewcAndRejectsUnsafeExecutable(t *testing.T) {
	for _, invalid := range []string{"", "traversal", "symlink", "duplicate", "missing", "truncated"} {
		name, mode := "./usr/bin/sing-box", uint32(0100755)
		if invalid == "traversal" {
			name = "../usr/bin/sing-box"
		}
		if invalid == "symlink" {
			mode = 0120777
		}
		if invalid == "missing" {
			name = "./other"
		}
		data := coreCPIOEntry(name, mode, "core")
		if invalid == "duplicate" {
			data = append(data, coreCPIOEntry(name, mode, "core")...)
		}
		data = append(data, coreCPIOEntry("TRAILER!!!", 0, "")...)
		if invalid == "truncated" {
			data = data[:20]
		}
		err := extractCoreCPIO(bytes.NewReader(data), filepath.Join(t.TempDir(), "candidate"))
		if (err != nil) != (invalid != "") {
			t.Fatal(invalid, err)
		}
	}
}

func TestCoreVersionReleasePinsOfficialPackageAndRequiredCapabilities(t *testing.T) {
	for _, manager := range []string{"apt", "dnf"} {
		var release coreGithubRelease
		release.ID, release.Tag = 1, "v1.14.2"
		name := "sing-box_1.14.2_linux_amd64.deb"
		if manager == "dnf" {
			name = "sing-box_1.14.2_linux_x86_64.rpm"
		}
		asset := struct {
			ID        int64     `json:"id"`
			Name      string    `json:"name"`
			URL       string    `json:"browser_download_url"`
			Size      int64     `json:"size"`
			UpdatedAt time.Time `json:"updated_at"`
			Digest    string    `json:"digest"`
		}{ID: 12, Name: name, URL: "https://github.com/SagerNet/sing-box/releases/download/v1.14.2/" + name, Size: 123, Digest: "sha256:" + strings.Repeat("a", 64)}
		release.Assets = append(release.Assets, asset)
		parsed, err := coreReleasePackage(release, "amd64", manager)
		if err != nil || parsed.Version != "1.14.2" || parsed.AssetName != name {
			t.Fatal(parsed, err)
		}
		for _, invalid := range []string{"digest", "origin", "old", "beta", "draft", "platform"} {
			bad := release
			bad.Assets = append(bad.Assets[:0:0], release.Assets...)
			platform := "amd64"
			switch invalid {
			case "digest":
				bad.Assets[0].Digest = ""
			case "origin":
				bad.Assets[0].URL = "https://evil.example/" + name
			case "old":
				bad.Tag = "v1.13.9"
			case "beta":
				bad.Prerelease = true
			case "draft":
				bad.Draft = true
			case "platform":
				platform = "mips"
			}
			if _, err := coreReleasePackage(bad, platform, manager); err == nil {
				t.Fatal("accepted unverified package", invalid)
			}
		}
	}
}
