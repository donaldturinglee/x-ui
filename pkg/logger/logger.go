package logger

import (
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/op/go-logging"
)

// module is the logging module name every backend level is registered against.
const module = "x-ui"

// bufferSize caps the in-memory ring the /logs endpoint reads from. The buffer
// exists because the panel has to be able to show its own recent history to an
// operator who has no shell on the host.
const bufferSize = 10240

type logEntry struct {
	time  string
	level logging.Level
	log   string
}

var (
	logger *logging.Logger

	// bufferMu guards logBuffer. Every cron job, HTTP handler and request
	// goroutine appends to it while GetLogs reads it from the /logs endpoint --
	// an unsynchronised append against the re-slice below can hand the reader a
	// stale header and an out-of-range index.
	bufferMu  sync.Mutex
	logBuffer []logEntry
)

func init() {
	// A package-level logger that panics until InitLogger runs is a trap for
	// the CLI, which logs before it has read any configuration.
	InitLogger(logging.INFO)
}

func InitLogger(level logging.Level) {
	newLogger := logging.MustGetLogger(module)
	backend := logging.NewLogBackend(os.Stderr, "", 0)
	format := logging.MustStringFormatter(`%{time:2006/01/02 15:04:05} %{level} - %{message}`)

	backendFormatter := logging.NewBackendFormatter(backend, format)
	backendLeveled := logging.AddModuleLevel(backendFormatter)
	backendLeveled.SetLevel(level, module)
	newLogger.SetBackend(backendLeveled)

	logger = newLogger
}

// ParseLevel maps a configured level name onto a logging level, falling back to
// INFO so an unreadable value never silences the log entirely.
func ParseLevel(level string) logging.Level {
	parsed, err := logging.LogLevel(level)
	if err != nil {
		return logging.INFO
	}
	return parsed
}

func GetLogger() *logging.Logger {
	return logger
}

func Debug(args ...interface{}) {
	logger.Debug(args...)
	addToBuffer("DEBUG", fmt.Sprint(args...))
}

func Debugf(format string, args ...interface{}) {
	logger.Debugf(format, args...)
	addToBuffer("DEBUG", fmt.Sprintf(format, args...))
}

func Info(args ...interface{}) {
	logger.Info(args...)
	addToBuffer("INFO", fmt.Sprint(args...))
}

func Infof(format string, args ...interface{}) {
	logger.Infof(format, args...)
	addToBuffer("INFO", fmt.Sprintf(format, args...))
}

func Warning(args ...interface{}) {
	logger.Warning(args...)
	addToBuffer("WARNING", fmt.Sprint(args...))
}

func Warningf(format string, args ...interface{}) {
	logger.Warningf(format, args...)
	addToBuffer("WARNING", fmt.Sprintf(format, args...))
}

func Error(args ...interface{}) {
	logger.Error(args...)
	addToBuffer("ERROR", fmt.Sprint(args...))
}

func Errorf(format string, args ...interface{}) {
	logger.Errorf(format, args...)
	addToBuffer("ERROR", fmt.Sprintf(format, args...))
}

func addToBuffer(level string, newLog string) {
	t := time.Now()
	logLevel, _ := logging.LogLevel(level)

	bufferMu.Lock()
	defer bufferMu.Unlock()

	if len(logBuffer) >= bufferSize {
		logBuffer = logBuffer[1:]
	}
	logBuffer = append(logBuffer, logEntry{
		time:  t.Format("2006/01/02 15:04:05"),
		level: logLevel,
		log:   newLog,
	})
}

// GetLogs returns at most c buffered lines at or above the given level, newest
// first.
func GetLogs(c int, level string) []string {
	var output []string
	logLevel := ParseLevel(level)

	bufferMu.Lock()
	defer bufferMu.Unlock()

	for i := len(logBuffer) - 1; i >= 0 && len(output) < c; i-- {
		if logBuffer[i].level <= logLevel {
			output = append(output, fmt.Sprintf("%s %s - %s", logBuffer[i].time, logBuffer[i].level, logBuffer[i].log))
		}
	}
	return output
}
