//go:build !linux && !windows

package service

import (
	"fmt"
	"os"
)

func lockPanelFile(file *os.File) (func(), error) {
	return nil, fmt.Errorf("Panel configuration locking is not available on this platform")
}
