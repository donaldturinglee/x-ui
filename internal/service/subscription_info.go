package service

import (
	"context"
	"sort"
)

// SubscriptionFormatInfo reports which assigned nodes a format can represent,
// without exposing their addresses or credentials.
type SubscriptionFormatInfo struct {
	NodeCount        int      `json:"nodeCount"`
	OmittedProtocols []string `json:"omittedProtocols"`
}

type ClientSubscriptionInfo struct {
	Enabled bool                              `json:"enabled"`
	Formats map[string]SubscriptionFormatInfo `json:"formats"`
}

// Info is read by the authenticated panel, including for disabled subscribers.
// The public subscription still uses the same empty refusal for every failure.
func (s *SubscriptionService) Info(ctx context.Context, id uint, host string) (*ClientSubscriptionInfo, error) {
	client, err := s.store.Clients.FindById(ctx, id)
	if err != nil {
		return nil, err
	}
	nodes, err := s.nodes(ctx, client, host)
	if err != nil {
		return nil, err
	}
	links, err := s.links.linksFor(ctx, client, host)
	if err != nil {
		return nil, err
	}
	return &ClientSubscriptionInfo{
		Enabled: client.Enable,
		Formats: subscriptionFormatsFor(nodes, len(links)),
	}, nil
}

func subscriptionFormatsFor(nodes []clientNode, linkCount int) map[string]SubscriptionFormatInfo {
	formats := make(map[string]SubscriptionFormatInfo, 3)
	for _, format := range []string{FormatLinks, FormatClash, FormatSingBox} {
		info := SubscriptionFormatInfo{OmittedProtocols: []string{}}
		omitted := make(map[string]bool)
		for i := range nodes {
			node := &nodes[i]
			var supported bool
			switch format {
			case FormatLinks:
				supported = HasLink(node.Type)
			case FormatClash:
				supported = clashProxy(node) != nil
			case FormatSingBox:
				supported = singBoxOutbound(node) != nil
			}
			if supported {
				info.NodeCount++
			} else {
				omitted[node.Type] = true
			}
		}
		if format == FormatLinks {
			// Mixed listeners can produce two links; count the actual output.
			info.NodeCount = linkCount
		}
		for protocol := range omitted {
			info.OmittedProtocols = append(info.OmittedProtocols, protocol)
		}
		sort.Strings(info.OmittedProtocols)
		formats[format] = info
	}
	return formats
}
