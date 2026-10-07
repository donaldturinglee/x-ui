//go:build !linux

package service

import "os"

func coreFileOwners(os.FileInfo) (int, int) { return -1, -1 }
