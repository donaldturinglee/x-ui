package service

import (
	"os"
	"syscall"
)

func coreFileOwners(info os.FileInfo) (int, int) {
	stat := info.Sys().(*syscall.Stat_t)
	return int(stat.Uid), int(stat.Gid)
}
