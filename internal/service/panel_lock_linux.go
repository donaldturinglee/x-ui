package service

import (
	"os"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"golang.org/x/sys/unix"
)

func lockPanelFile(file *os.File) (func(), error) {
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, domain.Conflictf("Panel configuration is being applied; try again when the restart finishes")
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN) }, nil
}
