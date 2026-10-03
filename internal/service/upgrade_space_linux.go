package service

import (
	"fmt"

	"golang.org/x/sys/unix"
)

func checkUpgradeSpace(directory string, required uint64) error {
	var info unix.Statfs_t
	if err := unix.Statfs(directory, &info); err != nil {
		return err
	}
	if info.Bsize <= 0 || info.Bavail < required/uint64(info.Bsize)+1 {
		return fmt.Errorf("Insufficient free space for the installation and database backup")
	}
	return nil
}
