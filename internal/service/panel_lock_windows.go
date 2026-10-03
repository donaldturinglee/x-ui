package service

import (
	"os"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"golang.org/x/sys/windows"
)

func lockPanelFile(file *os.File) (func(), error) {
	return lockPanelFileMode(file, false)
}

func lockPanelFileShared(file *os.File) (func(), error) {
	return lockPanelFileMode(file, true)
}

func lockPanelFileMode(file *os.File, shared bool) (func(), error) {
	var overlapped windows.Overlapped
	flags := uint32(windows.LOCKFILE_FAIL_IMMEDIATELY)
	if !shared {
		flags |= windows.LOCKFILE_EXCLUSIVE_LOCK
	}
	if err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, &overlapped); err != nil {
		return nil, domain.Conflictf("Panel configuration is being applied; try again when the restart finishes")
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped) }, nil
}
