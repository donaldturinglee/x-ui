package service

import (
	"reflect"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestRenameInboundReferences(t *testing.T) {
	tests := []struct {
		name, document, want string
		path                 []string
	}{
		{
			name:     "base configuration and nested logical rules",
			document: `{"route":{"final":"old","rules":[{"inbound":["old","other","old-prefix"],"outbound":"old"},{"type":"logical","rules":[{"inbound":"old","domain":["old"]}]}]},"dns":{"final":"old","rules":[{"type":"logical","rules":[{"inbound":["old"],"server":"old"}]}],"servers":[{"tag":"old","detour":"old"}]},"experimental":{"v2ray_api":{"stats":{"inbounds":["old"],"outbounds":["old"],"users":["old"]}}},"unrelated":{"inbound":"old","number":9007199254740993}}`,
			want:     `{"route":{"final":"old","rules":[{"inbound":["new","other","old-prefix"],"outbound":"old"},{"type":"logical","rules":[{"inbound":"new","domain":["old"]}]}]},"dns":{"final":"old","rules":[{"type":"logical","rules":[{"inbound":["new"],"server":"old"}]}],"servers":[{"tag":"old","detour":"old"}]},"experimental":{"v2ray_api":{"stats":{"inbounds":["new"],"outbounds":["old"],"users":["old"]}}},"unrelated":{"inbound":"old","number":9007199254740993}}`,
		},
		{
			name:     "only the inbound's top-level detour",
			path:     []string{"inbounds"},
			document: `{"detour":"old","tls":{"acme":{"http_client":{"detour":"old"}}},"users":[{"name":"old","password":"old","detour":"old"}],"headers":{"detour":"old"},"number":9007199254740993}`,
			want:     `{"detour":"new","tls":{"acme":{"http_client":{"detour":"old"}}},"users":[{"name":"old","password":"old","detour":"old"}],"headers":{"detour":"old"},"number":9007199254740993}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed, err := renameInboundReferences(domain.JSON(tt.document), tt.path, "old", "new")
			if err != nil || !changed {
				t.Fatalf("rename = %s, %v, %v", got, changed, err)
			}
			if canonicalJSON(t, string(got)) != canonicalJSON(t, tt.want) {
				t.Errorf("rename = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestRenameInboundReferencesPreservesUnrelatedDocuments(t *testing.T) {
	for _, document := range []string{
		"", "null", "{\n  \"detour\": \"old\"\n}",
		`{"route":{"rules":[{"headers":{"inbound":"old"},"custom":{"inbound":"old"}}]}}`,
	} {
		got, changed, err := renameInboundReferences(domain.JSON(document), nil, "old", "new")
		if err != nil || changed || string(got) != document {
			t.Errorf("rename(%q) = %q, %v, %v", document, got, changed, err)
		}
	}
}

func TestRenameInboundReferencesRejectsInvalidDocuments(t *testing.T) {
	for _, document := range []string{"{", "{} {}", "[]", `"old"`} {
		if _, _, err := renameInboundReferences(domain.JSON(document), nil, "old", "new"); err == nil {
			t.Errorf("rename(%q) accepted an invalid document", document)
		}
	}
}

func TestResolveInboundSamplesMergesRetriedNames(t *testing.T) {
	samples := []domain.Stat{
		{Resource: "inbound", Tag: "old", DateTime: 100, Direction: domain.DirectionUp, Traffic: 7},
		{Resource: "inbound", Tag: "new", DateTime: 100, Direction: domain.DirectionUp, Traffic: 3},
		{Resource: "inbound", Tag: "old", DateTime: 100, Direction: domain.DirectionDown, Traffic: 2},
		{Resource: "outbound", Tag: "old", DateTime: 100, Direction: domain.DirectionUp, Traffic: 9},
	}
	got := resolveInboundSamples(samples, map[string]string{"old": "new"})
	want := []domain.Stat{
		{Resource: "inbound", Tag: "new", DateTime: 100, Direction: domain.DirectionDown, Traffic: 2},
		{Resource: "inbound", Tag: "new", DateTime: 100, Direction: domain.DirectionUp, Traffic: 10},
		{Resource: "outbound", Tag: "old", DateTime: 100, Direction: domain.DirectionUp, Traffic: 9},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("resolved samples = %+v, want %+v", got, want)
	}
}
