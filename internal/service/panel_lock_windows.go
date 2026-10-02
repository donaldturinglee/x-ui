package service

import (
	"os"

	"github.com/donaldturinglee/x-ui/internal/domain"
	"golang.org/x/sys/windows"
)

func lockPanelFile(file *os.File) (func(), error) {
	var overlapped windows.Overlapped
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped); err != nil {
		return nil, domain.Conflictf("Panel configuration is being applied; try again when the restart finishes")
	}
	return func() { _ = windows.UnlockFileEx(windows.Handle(file.Fd()), 0, 1, 0, &overlapped) }, nil
}
