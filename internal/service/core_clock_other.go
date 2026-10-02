//go:build !linux

package service

func coreMonotonicMicro() int64 { return 0 }
