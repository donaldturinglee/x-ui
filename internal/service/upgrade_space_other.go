//go:build !linux

package service

func checkUpgradeSpace(string, uint64) error { return nil }
