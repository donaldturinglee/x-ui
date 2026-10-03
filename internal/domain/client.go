package domain

// Client is a subscriber of the tunnel: the record that carries a quota, an
// expiry and the traffic counted against them. It is what the panel exists to
// manage, and what the worker disables when either limit is reached.
type Client struct {
	Id     uint `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Enable bool `json:"enable" form:"enable" gorm:"not null;default:true"`
	// Name is the join key on every hot path: traffic is reported against it and
	// a subscription is fetched by it. It is unique, and renaming one breaks
	// that subscriber's link -- which is why the constraint is on the column
	// rather than only in the service.
	Name string `json:"name" form:"name" gorm:"uniqueIndex"`
	// Inbounds is the set of inbound ids this client may connect through, as a
	// JSON array of numbers.
	Inbounds JSON `json:"inbounds" form:"inbounds" gorm:"type:jsonb"`
	// Config holds the per-protocol identities (uuid, password, ...) the client
	// authenticates with.
	Config JSON `json:"config,omitempty" form:"config" gorm:"type:jsonb"`

	// Volume is the traffic quota in bytes; 0 means unlimited.
	Volume int64 `json:"volume" form:"volume" gorm:"not null;default:0"`
	// Expiry is a unix time; 0 means it never expires.
	Expiry int64 `json:"expiry" form:"expiry" gorm:"not null;default:0"`
	// Up and Down are the bytes counted in the current period.
	Up   int64 `json:"up" form:"up" gorm:"not null;default:0"`
	Down int64 `json:"down" form:"down" gorm:"not null;default:0"`
	// TotalUp and TotalDown survive a periodic reset, so a client's lifetime
	// traffic is still visible after its counters are zeroed.
	TotalUp   int64 `json:"totalUp" form:"totalUp" gorm:"not null;default:0"`
	TotalDown int64 `json:"totalDown" form:"totalDown" gorm:"not null;default:0"`

	Desc  string `json:"desc" form:"desc" gorm:"column:description"`
	Group string `json:"group" form:"group" gorm:"column:group_name;index"`

	// CreatedAt and OnlineAt are unix seconds: creation, and the last time the
	// client had traffic.
	CreatedAt int64 `json:"createdAt" form:"createdAt" gorm:"not null;default:0"`
	OnlineAt  int64 `json:"onlineAt" form:"onlineAt" gorm:"not null;default:0"`

	// DelayStart holds the expiry clock until the client's first byte, so a
	// subscription sold today does not start counting down before it is used.
	DelayStart bool `json:"delayStart" form:"delayStart" gorm:"not null;default:false"`
	// AutoReset restarts the quota every ResetDays days.
	AutoReset bool  `json:"autoReset" form:"autoReset" gorm:"not null;default:false"`
	ResetDays int   `json:"resetDays" form:"resetDays" gorm:"not null;default:0"`
	NextReset int64 `json:"nextReset" form:"nextReset" gorm:"not null;default:0"`
}

func (Client) TableName() string {
	return "clients"
}

// secondsPerDay converts the day-denominated reset period into the unix
// seconds every timestamp on this record is kept in.
const secondsPerDay int64 = 86400

// Used is the traffic counted in the current period.
func (c Client) Used() int64 {
	return c.Up + c.Down
}

// LifetimeUsed is the traffic counted since the client was created, across
// every reset.
func (c Client) LifetimeUsed() int64 {
	return c.TotalUp + c.TotalDown + c.Used()
}

// OverQuota reports whether the client has spent its volume. An unlimited
// client never has.
func (c Client) OverQuota() bool {
	return c.Volume > 0 && c.Used() > c.Volume
}

// Expired reports whether the client is past its expiry. One that never expires
// never is, and neither does one whose clock has not started.
func (c Client) Expired(now int64) bool {
	return !c.DelayStart && c.Expiry > 0 && c.Expiry < now
}

// Depleted reports whether an enabled client has reached either limit and
// should be taken offline.
func (c Client) Depleted(now int64) bool {
	return c.Enable && (c.OverQuota() || c.Expired(now))
}

// AwaitingFirstByte reports whether the client's clock is still held, waiting
// for it to be used for the first time.
func (c Client) AwaitingFirstByte() bool {
	return c.Enable && c.DelayStart && c.Used() > 0
}

// DueForReset reports whether a periodic client has reached its next reset.
// ResetDays must be positive: at zero the next reset lands on the moment it is
// computed, and the client's quota resets every time the worker runs.
func (c Client) DueForReset(now int64) bool {
	return !c.DelayStart && c.AutoReset && c.ResetDays > 0 && c.NextReset < now
}

// StartClock begins a held expiry or reset period at now, and is what
// DelayStart is waiting for.
func (c *Client) StartClock(now int64) {
	period := int64(c.ResetDays) * secondsPerDay
	if c.AutoReset {
		c.NextReset = now + period
	} else {
		c.Expiry = now + period
	}
	c.DelayStart = false
}

// ResetPeriod rolls the current period's traffic into the lifetime totals and
// starts the next one.
func (c *Client) ResetPeriod(now int64) {
	c.TotalUp += c.Up
	c.TotalDown += c.Down
	c.Up = 0
	c.Down = 0
	c.NextReset = now + int64(c.ResetDays)*secondsPerDay
}
