package service

import "golang.org/x/sys/unix"

func coreMonotonicMicro() int64 {
	var timestamp unix.Timespec
	if unix.ClockGettime(unix.CLOCK_MONOTONIC, &timestamp) != nil {
		return 0
	}
	return timestamp.Sec*1_000_000 + timestamp.Nsec/1_000
}
