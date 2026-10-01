#!/usr/bin/env bash
#
# Run the tests with coverage and write the HTML report.
#
# Usage:
#   scripts/cover.sh

set -euo pipefail

cd "$(dirname "$0")/.."

go test -coverprofile=coverage.out ./...
go tool cover -html=coverage.out -o coverage.html

echo "wrote coverage.html"
