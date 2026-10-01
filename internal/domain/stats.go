package domain

// Resources traffic is counted against.
const (
	ResourceInbound  = "inbound"
	ResourceOutbound = "outbound"
	ResourceClient   = "client"
)

// Traffic directions. Stored as a bool because there are two of them and a
// bucket row is written for each; the constants are what the code reads.
const (
	DirectionUp   = true
	DirectionDown = false
)

// Stat is one traffic bucket: the bytes a single resource moved in one
// direction during one interval.
//
// (resource, tag, date_time, direction) is unique, and samples arriving within
// the same bucket are added onto the existing row rather than inserted
// alongside it. Without that, a reporting interval shorter than the bucket
// multiplies the row count by the ratio between them.
type Stat struct {
	Id uint64 `json:"id" gorm:"primaryKey;autoIncrement"`
	// DateTime is the start of the bucket, in unix seconds.
	DateTime  int64  `json:"dateTime" gorm:"uniqueIndex:idx_stats_bucket,priority:3;index:idx_stats_date_time"`
	Resource  string `json:"resource" gorm:"uniqueIndex:idx_stats_bucket,priority:1"`
	Tag       string `json:"tag" gorm:"uniqueIndex:idx_stats_bucket,priority:2"`
	Direction bool   `json:"direction" gorm:"uniqueIndex:idx_stats_bucket,priority:4"`
	Traffic   int64  `json:"traffic"`
}

func (Stat) TableName() string {
	return "stats"
}

// Bucket rounds a unix time down to the start of the bucket it falls in.
func Bucket(at int64, seconds int64) int64 {
	if seconds < 1 {
		seconds = 1
	}
	return at - (at % seconds)
}

// Traffic is a pair of byte counts in both directions.
type Traffic struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

// Total is the traffic in both directions together.
func (t Traffic) Total() int64 {
	return t.Up + t.Down
}

// TrafficReport is one resource's traffic since the last report, as a node
// sends it in. It is a delta, not a running total: a node that restarts and
// starts counting from zero again would otherwise subtract its own history
// from every client it serves.
type TrafficReport struct {
	Resource string `json:"resource"`
	Tag      string `json:"tag"`
	Up       int64  `json:"up"`
	Down     int64  `json:"down"`
}

// Actors that appear in the audit log. A change made through the panel records
// the operator's username instead.
const (
	ActorDepleteJob = "DepleteJob"
	ActorResetJob   = "ResetJob"
	ActorSystem     = "System"
)

// Change is one entry in the audit log: who changed what, when, and to what.
//
// It answers the question an operator asks after the fact -- why is this client
// disabled -- which neither the row itself nor the process log can, because the
// row holds only its current state and the log is rotated away.
type Change struct {
	Id       uint64 `json:"id" gorm:"primaryKey;autoIncrement"`
	DateTime int64  `json:"dateTime" gorm:"index"`
	// Actor is an operator's username, or one of the job names above.
	Actor string `json:"actor" gorm:"index"`
	// Key is the kind of object that changed, e.g. "clients".
	Key string `json:"key" gorm:"index"`
	// Action is what happened to it, e.g. "new", "edit", "del", "disable".
	Action string `json:"action"`
	// Obj identifies the object, and for an edit holds what it became.
	Obj JSON `json:"obj" gorm:"type:jsonb"`
}

func (Change) TableName() string {
	return "changes"
}
