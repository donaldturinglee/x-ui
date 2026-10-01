package agent

import (
	"errors"
	"os"
	"strconv"
	"strings"
)

// ReadEnvironment reads the installer's one-line systemd environment values.
// It deliberately never evaluates substitutions or invokes a shell.
func ReadEnvironment(path string) (map[string]string, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found {
			return nil, errors.New("invalid agent environment file")
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, `"`) {
			value, err = strconv.Unquote(value)
			if err != nil {
				return nil, errors.New("invalid quoted agent environment value")
			}
		} else if strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			value = strings.TrimSuffix(strings.TrimPrefix(value, "'"), "'")
		}
		values[strings.TrimSpace(key)] = value
	}
	return values, nil
}
