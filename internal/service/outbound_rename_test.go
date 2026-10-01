package service

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestRenameOutboundReferences(t *testing.T) {
	tests := []struct {
		name, document, want string
		path                 []string
	}{
		{
			name: "base configuration and logical rules",
			document: `{
				"route":{"final":"old","rules":[{"outbound":"old"},{"type":"logical","rules":[{"outbound":"old","domain":["old"]}]}],
					"rule_set":[{"tag":"old","download_detour":"old","http_client":{"detour":"old"}}]},
				"dns":{"final":"old","servers":[{"tag":"old","detour":"old"}],"rules":[{"outbound":["old","other"],"server":"old"}]},
				"ntp":{"detour":"old"},"http_clients":[{"tag":"old","detour":"old","headers":{"detour":"old","outbound":"old"}}],
				"experimental":{"v2ray_api":{"stats":{"inbounds":["old"],"users":["old"],"outbounds":["old","other"]}},"clash_api":{"external_ui_download_detour":"old"}},
				"unrelated":{"outbound":"old","final":"old","default":"old","outbounds":["old"],"number":9007199254740993}
			}`,
			want: `{
				"route":{"final":"new","rules":[{"outbound":"new"},{"type":"logical","rules":[{"outbound":"new","domain":["old"]}]}],
					"rule_set":[{"tag":"old","download_detour":"new","http_client":{"detour":"new"}}]},
				"dns":{"final":"old","servers":[{"tag":"old","detour":"new"}],"rules":[{"outbound":["new","other"],"server":"old"}]},
				"ntp":{"detour":"new"},"http_clients":[{"tag":"old","detour":"new","headers":{"detour":"old","outbound":"old"}}],
				"experimental":{"v2ray_api":{"stats":{"inbounds":["old"],"users":["old"],"outbounds":["new","other"]}},"clash_api":{"external_ui_download_detour":"new"}},
				"unrelated":{"outbound":"old","final":"old","default":"old","outbounds":["old"],"number":9007199254740993}
			}`,
		},
		{
			name: "selector members and default",
			path: []string{"outbounds", "selector"},
			document: `{"outbounds":["old","other","old-prefix"],"default":"old","detour":"old",` +
				`"password":"old","server":"old","headers":{"detour":"old"},"routing_mark":9007199254740993}`,
			want: `{"outbounds":["new","other","old-prefix"],"default":"new","detour":"new",` +
				`"password":"old","server":"old","headers":{"detour":"old"},"routing_mark":9007199254740993}`,
		},
		{
			name:     "urltest members",
			path:     []string{"outbounds", "urltest"},
			document: `{"outbounds":["old","other"],"url":"https://old.example/test"}`,
			want:     `{"outbounds":["new","other"],"url":"https://old.example/test"}`,
		},
		{
			name:     "inbound detour is a different namespace",
			path:     []string{"inbounds"},
			document: `{"detour":"old","tls":{"acme":{"http_client":{"detour":"old"}}},"users":[{"name":"old","password":"old","detour":"old"}]}`,
			want:     `{"detour":"old","tls":{"acme":{"http_client":{"detour":"new"}}},"users":[{"name":"old","password":"old","detour":"old"}]}`,
		},
		{
			name:     "wireguard endpoint dial fields",
			path:     []string{"outbounds", "wireguard"},
			document: `{"detour":"old","private_key":"old","peers":[{"address":"old","public_key":"old"}]}`,
			want:     `{"detour":"new","private_key":"old","peers":[{"address":"old","public_key":"old"}]}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, changed, err := renameOutboundReferences(domain.JSON(tt.document), tt.path, "old", "new")
			if err != nil || !changed {
				t.Fatalf("rename = %s, %v, %v", got, changed, err)
			}
			if canonicalJSON(t, string(got)) != canonicalJSON(t, tt.want) {
				t.Errorf("rename = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestRenameOutboundReferencesLeavesUnchangedDocumentsExact(t *testing.T) {
	for _, document := range []string{"", "null", "{\n  \"detour\": \"other\", \"password\": \"old\"\n}"} {
		got, changed, err := renameOutboundReferences(domain.JSON(document), nil, "old", "new")
		if err != nil || changed || string(got) != document {
			t.Errorf("rename(%q) = %q, %v, %v", document, got, changed, err)
		}
	}
}

func TestRenameOutboundReferencesRejectsInvalidDocuments(t *testing.T) {
	for _, document := range []string{"{", "{} {}", "[]", `"old"`} {
		if _, _, err := renameOutboundReferences(domain.JSON(document), nil, "old", "new"); err == nil {
			t.Errorf("rename(%q) accepted an invalid options document", document)
		}
	}
}

func canonicalJSON(t *testing.T, document string) string {
	t.Helper()
	var value interface{}
	decoder := json.NewDecoder(strings.NewReader(document))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(result)
}
