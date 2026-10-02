package config

import "github.com/robfig/cron/v3"

// CronParser is shared by the worker and the settings validator.
func CronParser() cron.Parser {
	return cron.NewParser(cron.SecondOptional | cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow | cron.Descriptor)
}
