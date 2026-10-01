package service

import (
	"errors"
	"testing"

	"github.com/donaldturinglee/x-ui/internal/domain"
)

func TestTheBotsSwitchesAreWrittenOneWay(t *testing.T) {
	for _, value := range []string{"true", "TRUE", "1", "t"} {
		if got, err := normaliseSetting(domain.SettingTgBotEnable, value); err != nil || got != "true" {
			t.Errorf("%q read as %q (%v), want true", value, got, err)
		}
	}
	if _, err := normaliseSetting(domain.SettingTgNotifyDeplete, "sometimes"); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("err = %v, want a switch that is neither refused", err)
	}
}

func TestABotTokenIsOneBotFatherWouldHandOut(t *testing.T) {
	if _, err := normaliseSetting(domain.SettingTgBotToken, testBotToken); err != nil {
		t.Errorf("a real token's shape was refused: %v", err)
	}
	// Empty is a bot that has not been set up yet.
	if _, err := normaliseSetting(domain.SettingTgBotToken, ""); err != nil {
		t.Errorf("an empty token was refused: %v", err)
	}
	for _, wrong := range []string{"AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", "123456789:short", "https://t.me/bot"} {
		if _, err := normaliseSetting(domain.SettingTgBotToken, wrong); !errors.Is(err, domain.ErrInvalid) {
			t.Errorf("%q was taken as a token", wrong)
		}
	}
}

func TestChatsAreWrittenAsAListOfIds(t *testing.T) {
	got, err := normaliseSetting(domain.SettingTgBotChatIds, " 1111 , -100222,, ")
	if err != nil || got != "1111,-100222" {
		t.Errorf("chats = %q (%v), want the ids and nothing else", got, err)
	}
	if _, err := normaliseSetting(domain.SettingTgBotChatIds, "1111,@channel"); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("err = %v, want a chat that is not an id refused", err)
	}
}

func TestTheOtherSettingsAreStoredAsTheyCame(t *testing.T) {
	// Saved unjudged before the bot had settings of its own, so a row written
	// then keeps saving.
	if got, err := normaliseSetting(domain.SettingSubUpdates, "soon"); err != nil || got != "soon" {
		t.Errorf("subUpdates = %q (%v), want it stored as it came", got, err)
	}
}
