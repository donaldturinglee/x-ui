package domain

// Setting is one runtime option, stored as a string and parsed by the service
// that owns it.
//
// Everything the process needs in order to start -- ports, paths, credentials,
// timeouts -- lives in the config file instead. What is left here is what an
// operator changes while the panel is running and expects to survive a restart,
// which is exactly the set that cannot come from a file the operator may not be
// able to edit.
type Setting struct {
	Id    uint   `json:"id" form:"id" gorm:"primaryKey;autoIncrement"`
	Key   string `json:"key" form:"key" gorm:"uniqueIndex"`
	Value string `json:"value" form:"value"`
}

func (Setting) TableName() string {
	return "settings"
}

// Setting keys. They are named here rather than spelled out at each use so a
// typo is a compile error instead of a value that silently reads as its
// default.
const (
	// SettingMaintenance holds clients offline on purpose. It is stored rather
	// than held in memory so a reboot during maintenance does not quietly put
	// everyone back online.
	SettingMaintenance = "maintenance"
	// SettingSubUpdates is the refresh interval, in hours, advertised to a
	// subscription client.
	SettingSubUpdates = "subUpdates"
	// SettingSubEncode base64-encodes the subscription body, which some clients
	// require.
	SettingSubEncode = "subEncode"
	// SettingSubShowInfo adds the remaining quota and expiry to the
	// subscription as a pseudo-entry clients display as a title.
	SettingSubShowInfo = "subShowInfo"
	// SettingTgBotEnable sends the panel's notifications to Telegram. Switched
	// off, the bot's token and chats are kept and nothing is sent.
	SettingTgBotEnable = "tgBotEnable"
	// SettingTgBotToken is the bot's token, as @BotFather hands it out.
	SettingTgBotToken = "tgBotToken"
	// SettingTgBotChatIds are the chats the notifications go to, comma separated:
	// an operator's own chat with the bot, or a group the bot is in.
	SettingTgBotChatIds = "tgBotChatIds"
	// SettingTgNotifySignIn tells the chats when an operator signs in to the
	// panel, and from where.
	SettingTgNotifySignIn = "tgNotifySignIn"
	// SettingTgNotifyDeplete tells the chats which subscribers the worker took
	// offline for running out of quota or time.
	SettingTgNotifyDeplete = "tgNotifyDeplete"
	// The externally reachable address of the subscription endpoint is not here.
	// It is subscription.public_url in configs/, with the rest of what describes
	// that listener -- its port, path, domain and certificate. Keeping the
	// address beside them is what stops the two disagreeing; a copy in this
	// table would be a second answer to a question the file already answers.
	// SettingCoreConfig is the base document a node's configuration is
	// generated from. It is edited through its own endpoint rather than the
	// settings form: it is a JSON document with its own validation, and it is
	// far too easy to blank by posting a settings form that did not know about
	// it.
	SettingCoreConfig = "config"
	// SettingGlobalResetLast is the unix time of the last global traffic reset.
	// Bookkeeping, not an operator setting.
	SettingGlobalResetLast = "globalResetLast"
	// SettingVersion records the schema the data was last written by.
	// Bookkeeping, not an operator setting.
	SettingVersion = "version"
)

// DefaultSettings is every key the panel knows, with the value used until an
// operator changes it. A key absent from this map is rejected on save: an
// unknown key would otherwise be stored, read by nothing, and look like it had
// taken effect.
var DefaultSettings = map[string]string{
	SettingMaintenance:     "false",
	SettingSubUpdates:      "12",
	SettingSubEncode:       "true",
	SettingSubShowInfo:     "false",
	SettingTgBotEnable:     "false",
	SettingTgBotToken:      "",
	SettingTgBotChatIds:    "",
	SettingTgNotifySignIn:  "true",
	SettingTgNotifyDeplete: "true",
	SettingCoreConfig:      DefaultCoreConfig,
	SettingGlobalResetLast: "0",
	SettingVersion:         "",
}

// ProtectedSettings never travel over the settings endpoint, in either
// direction.
//
// version and globalResetLast are bookkeeping the panel writes for itself.
// maintenance and config are here for a different reason: each has an endpoint
// of its own that does more than write the value -- stopping service, or
// validating a document -- and letting either through the generic save would
// leave the two paths disagreeing.
var ProtectedSettings = map[string]bool{
	SettingMaintenance:     true,
	SettingCoreConfig:      true,
	SettingGlobalResetLast: true,
	SettingVersion:         true,
}
