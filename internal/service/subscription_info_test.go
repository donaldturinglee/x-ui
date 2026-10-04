package service

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestSubscriptionFormatsReportOmissionsAndActualLinkCount(t *testing.T) {
	nodes := []clientNode{*vlessNode(), {Type: "naive"}, {Type: "snell"}, {Type: "hysteria"},
		{Type: "vless", Transport: map[string]interface{}{"type": "quic"}}}
	formats := subscriptionFormatsFor(nodes, 5)
	for _, test := range []struct {
		format  string
		count   int
		omitted []string
	}{
		{FormatLinks, 5, []string{"snell"}},
		{FormatClash, 1, []string{"hysteria", "naive", "snell", "vless"}},
		{FormatSingBox, 4, []string{"hysteria"}},
	} {
		info := formats[test.format]
		if info.NodeCount != test.count || !reflect.DeepEqual(info.OmittedProtocols, test.omitted) {
			t.Errorf("%s = %+v, want %d nodes and omitted %v", test.format, info, test.count, test.omitted)
		}
	}
}

func TestSubscriptionFormatsKeepEmptyProtocolListsAsArrays(t *testing.T) {
	formats := subscriptionFormatsFor(nil, 0)
	for _, format := range []string{FormatLinks, FormatClash, FormatSingBox} {
		info, ok := formats[format]
		if !ok || info.NodeCount != 0 || info.OmittedProtocols == nil {
			t.Fatalf("%s = %+v, want an explicit empty format", format, info)
		}
		encoded, _ := json.Marshal(info)
		if string(encoded) != `{"nodeCount":0,"omittedProtocols":[]}` {
			t.Errorf("%s = %s", format, encoded)
		}
	}
}
