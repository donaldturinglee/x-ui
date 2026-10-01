package agent

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// NewSingBoxStats reads authenticated users and tags from sing-box's native
// API. Its Clash-compatible response omits these fields, so that response
// cannot account traffic against a subscriber's quota.
func NewSingBoxStats(cfg StatsConfig) *ClashStats {
	stats := NewClashStats(cfg)
	stats.readSnapshot = stats.fetchSingBox
	return stats
}

func (c *ClashStats) fetchSingBox(ctx context.Context) (*clashConnections, error) {
	// SubscribeConnections initially returns a complete connection snapshot.
	// Read that first message and close the stream; the regular reporting loop
	// computes deltas from the native API's cumulative totals.
	payload := protowire.AppendTag(nil, 1, protowire.VarintType)
	payload = protowire.AppendVarint(payload, uint64(time.Second))
	frame := make([]byte, 5, 5+len(payload))
	binary.BigEndian.PutUint32(frame[1:], uint32(len(payload)))
	frame = append(frame, payload...)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.url+"/daemon.StartedService/SubscribeConnections", bytes.NewReader(frame))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/grpc-web+proto")
	req.Header.Set("X-Grpc-Web", "1")
	if c.secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.secret)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("read sing-box connections: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("sing-box API answered %s", res.Status)
	}
	if status := res.Header.Get("Grpc-Status"); status != "" && status != "0" {
		return nil, fmt.Errorf("sing-box API gRPC status %s", status)
	}
	var header [5]byte
	if _, err := io.ReadFull(res.Body, header[:]); err != nil {
		return nil, fmt.Errorf("read sing-box API frame: %w", err)
	}
	size := binary.BigEndian.Uint32(header[1:])
	if size > maxResponseBytes {
		return nil, fmt.Errorf("sing-box API frame exceeds %d bytes", maxResponseBytes)
	}
	message := make([]byte, size)
	if _, err := io.ReadFull(res.Body, message); err != nil {
		return nil, fmt.Errorf("read sing-box API message: %w", err)
	}
	if header[0] != 0 {
		if header[0] == 0x80 {
			return nil, fmt.Errorf("sing-box API ended before its snapshot: %s", summarise(message))
		}
		return nil, fmt.Errorf("unsupported sing-box API frame flags %d", header[0])
	}
	return decodeSingBoxConnections(message)
}

// Only the accounting fields are decoded. Wire numbers come from sing-box's
// daemon/started_service.proto; skipping other fields keeps the reader
// compatible with new optional fields without adding the entire core SDK.
func decodeSingBoxConnections(message []byte) (*clashConnections, error) {
	snapshot := &clashConnections{}
	err := walkProto(message, func(number protowire.Number, kind protowire.Type, _ uint64, event []byte) error {
		if number != 1 {
			return nil
		}
		if kind != protowire.BytesType {
			return fmt.Errorf("invalid connection event wire type")
		}
		return walkProto(event, func(number protowire.Number, kind protowire.Type, _ uint64, document []byte) error {
			if number != 3 {
				return nil
			}
			if kind != protowire.BytesType {
				return fmt.Errorf("invalid connection wire type")
			}
			connection, err := decodeSingBoxConnection(document)
			if err != nil {
				return err
			}
			if connection.ID != "" {
				snapshot.Connections = append(snapshot.Connections, connection)
			}
			return nil
		})
	})
	return snapshot, err
}

func decodeSingBoxConnection(document []byte) (clashConnection, error) {
	var connection clashConnection
	err := walkProto(document, func(number protowire.Number, kind protowire.Type, total uint64, value []byte) error {
		switch number {
		case 1, 2, 10, 19:
			if kind != protowire.BytesType {
				return fmt.Errorf("invalid connection identity wire type")
			}
			switch number {
			case 1:
				connection.ID = string(value)
			case 2:
				connection.Metadata.InboundTag = string(value)
			case 10:
				connection.Metadata.User = string(value)
			case 19:
				connection.Metadata.OutboundTag = string(value)
			}
		case 16, 17:
			if kind != protowire.VarintType || total > math.MaxInt64 {
				return fmt.Errorf("invalid connection traffic total")
			}
			if number == 16 {
				connection.Upload = int64(total)
			} else {
				connection.Download = int64(total)
			}
		}
		return nil
	})
	return connection, err
}

func walkProto(document []byte, visit func(protowire.Number, protowire.Type, uint64, []byte) error) error {
	for len(document) > 0 {
		number, kind, consumed := protowire.ConsumeTag(document)
		if consumed < 0 {
			return protowire.ParseError(consumed)
		}
		document = document[consumed:]
		var total uint64
		var value []byte
		switch kind {
		case protowire.VarintType:
			total, consumed = protowire.ConsumeVarint(document)
		case protowire.BytesType:
			value, consumed = protowire.ConsumeBytes(document)
		default:
			consumed = protowire.ConsumeFieldValue(number, kind, document)
		}
		if consumed < 0 {
			return protowire.ParseError(consumed)
		}
		if err := visit(number, kind, total, value); err != nil {
			return err
		}
		document = document[consumed:]
	}
	return nil
}
