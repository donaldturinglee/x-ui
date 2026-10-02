// Command cli is the administrative entry point: account recovery, migrations,
// settings and a health probe.
//
// It is what an operator reaches for when the panel is what is broken, so
// every subcommand works against the database directly and none of them needs
// the API to be up.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/donaldturinglee/x-ui/internal/config"
	"github.com/donaldturinglee/x-ui/internal/database"
	"github.com/donaldturinglee/x-ui/internal/domain"
	"github.com/donaldturinglee/x-ui/internal/repository"
	"github.com/donaldturinglee/x-ui/internal/service"
	"github.com/donaldturinglee/x-ui/pkg/logger"

	"gorm.io/gorm"
)

// commandTimeout bounds any one subcommand. These run interactively, and a
// command that has hung on an unreachable database should say so rather than
// sit there.
const commandTimeout = 60 * time.Second

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 0 {
		usage()
		return errors.New("no command given")
	}

	command, rest := args[0], args[1:]
	switch command {
	case "version", "-v", "--version":
		fmt.Println(config.Name, config.Version)
		return nil
	case "help", "-h", "--help":
		usage()
		return nil
	case "admin":
		return adminCommand(rest)
	case "seed":
		return seedCommand(rest)
	case "token":
		return tokenCommand(rest)
	case "node":
		return nodeCommand(rest)
	case "panel-restart":
		return panelRestartCommand(rest)
	case "core-restart":
		return coreRestartCommand(rest)
	case "database":
		return databaseCommand(rest)
	case "migrate":
		return migrateCommand(rest)
	case "setting":
		return settingCommand(rest)
	case "backup":
		return backupCommand(rest)
	case "healthcheck":
		return healthcheckCommand(rest)
	default:
		usage()
		return fmt.Errorf("unknown command %q", command)
	}
}

func usage() {
	fmt.Println("Usage: x-ui-cli <command> [flags]")
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("    admin          show or set operator credentials and two-factor authentication")
	fmt.Println("    seed           create the root account when the panel has none")
	fmt.Println("    token          create an API token for an operator (restart a running API to load it)")
	fmt.Println("    node           configure or check the local node and native statistics")
	fmt.Println("    panel-restart  execute a queued Panel restart task (service manager only)")
	fmt.Println("    core-restart   execute a queued local sing-box restart task (service manager only)")
	fmt.Println("    database       check backup tools, back up or restore the complete database")
	fmt.Println("    migrate        apply, roll back or inspect database migrations")
	fmt.Println("    setting        show or reset runtime settings")
	fmt.Println("    backup         export the data, or restore it from an export")
	fmt.Println("    healthcheck    exit 0 if the panel answers on its configured address")
	fmt.Println("    version        print the version")
	fmt.Println()
	fmt.Println("Configuration is read from X_UI_CONFIG_DIR (default: configs),")
	fmt.Println("and any X_UI_* variable overrides what the file says.")
}

// adminCommand shows or sets operator credentials.
//
// There is deliberately no "reset to a default password": a command that turns
// a live panel into one with well-known credentials, reachable from the
// internet, is not a recovery tool. Setting an explicit password covers the
// same need without the window.
//
// Turning an account's two-factor authentication off is here for the same
// reason setting a password is: an operator whose authenticator is lost cannot
// do it from the panel, which asks for a code to do it.
func adminCommand(args []string) error {
	fs := flag.NewFlagSet("admin", flag.ExitOnError)
	var (
		show             bool
		list             bool
		username         string
		password         string
		disableTwoFactor string
	)
	fs.BoolVar(&show, "show", false, "show the first operator account")
	fs.BoolVar(&list, "list", false, "list every operator account")
	fs.StringVar(&username, "username", "", "username to set")
	fs.StringVar(&password, "password", "", "password to set")
	fs.StringVar(&disableTwoFactor, "disable-two-factor", "", "turn two-factor authentication off for this account")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return withStore(func(ctx context.Context, store *repository.Store) error {
		users := service.NewUserService(store)

		switch {
		case list:
			accounts, err := users.List(ctx)
			if err != nil {
				return err
			}
			if len(accounts) == 0 {
				fmt.Println("no operator accounts exist")
				return nil
			}
			for _, account := range accounts {
				fmt.Printf("%d\t%s\tlast sign-in: %s\ttwo-factor: %s\n",
					account.Id, account.Username, orNever(account.LastSignIn), onOff(account.HasTwoFactor()))
			}
			return nil

		case disableTwoFactor != "":
			if err := users.ResetTwoFactor(ctx, disableTwoFactor); err != nil {
				return err
			}
			fmt.Println("two-factor authentication is off for", disableTwoFactor)
			return nil

		case show:
			account, err := users.First(ctx)
			if err != nil {
				return err
			}
			fmt.Println("First operator account:")
			fmt.Println("\tUsername:\t", account.Username)
			fmt.Println("\tPassword:\t <hashed, not recoverable>")
			fmt.Println("\tLast sign-in:\t", orNever(account.LastSignIn))
			return nil

		case username != "" || password != "":
			created, err := users.EnsureInitialUser(ctx, username, password)
			if err != nil {
				return err
			}
			if created {
				fmt.Println("created operator account", username)
				return nil
			}
			account, err := users.First(ctx)
			if err != nil {
				return err
			}
			if err := users.SetCredentials(ctx, account.Id, username, password); err != nil {
				return err
			}
			fmt.Println("updated operator account", username)
			return nil

		default:
			fs.Usage()
			return errors.New("nothing to do: pass -show, -list, -disable-two-factor, or -username and -password")
		}
	})
}

// seedCommand creates the root account on a panel that has none.
//
// It is the one step between an empty database and being able to sign in, and
// it is separated from `admin` because the two answer different questions.
// `admin` is what an operator reaches for when they are locked out of a running
// panel; this is what a deploy script runs once, straight after `migrate`, and
// it has to be safe to run again when that script is re-run.
//
// So it is idempotent rather than authoritative: an existing account is left
// exactly as it is, and re-seeding never rewrites a password an operator has
// since changed. Changing one is `admin -username -password`, which says what
// it does.
//
// Like every other path to the first account, it does not invent a password.
// X_UI_ROOT_USERNAME and X_UI_ROOT_PASSWORD are the same pair the
// API reads when it bootstraps at startup, so a deployment that already sets
// them needs no flags here.
func seedCommand(args []string) error {
	fs := flag.NewFlagSet("seed", flag.ExitOnError)
	var (
		username string
		password string
	)
	fs.StringVar(&username, "username", "", "username for the root account (default: "+config.RootUsernameEnv+")")
	fs.StringVar(&password, "password", "", "password for the root account (default: "+config.RootPasswordEnv+")")
	if err := fs.Parse(args); err != nil {
		return err
	}
	username, password = rootCredentials(username, password)

	return withStore(func(ctx context.Context, store *repository.Store) error {
		users := service.NewUserService(store)

		// Checked before the credentials are, so that re-running the seed
		// against a panel that is already set up succeeds without needing the
		// environment that set it up in the first place.
		count, err := users.Count(ctx)
		if err != nil {
			return err
		}
		if count > 0 {
			fmt.Println("an operator account already exists: nothing to seed")
			return nil
		}

		if username == "" || password == "" {
			return fmt.Errorf("no credentials: pass -username and -password, or set %s and %s",
				config.RootUsernameEnv, config.RootPasswordEnv)
		}

		created, err := users.EnsureInitialUser(ctx, username, password)
		if err != nil {
			return err
		}
		// A false here means another process created an account between the
		// count above and this call -- the panel starting, or a second copy of
		// the same deploy script. Either way the panel has its account, which
		// is what was being asked for.
		if !created {
			fmt.Println("an operator account already exists: nothing to seed")
			return nil
		}
		fmt.Println("created the root account", username)
		return nil
	})
}

// rootCredentials fills in whichever half the flags left empty from the
// environment. Each half falls back on its own, so a deploy script can name the
// username on the command line and leave the password in the environment --
// where it is not in the process table for every other user on the host to
// read.
func rootCredentials(username string, password string) (string, string) {
	if username == "" {
		username = os.Getenv(config.RootUsernameEnv)
	}
	if password == "" {
		password = os.Getenv(config.RootPasswordEnv)
	}
	return username, password
}

// tokenCommand is used by the single-host installer before it starts the API,
// so the API's in-memory token table includes the new token on its first load.
// The secret is the only stdout output: an installer can capture it without
// putting it in process arguments or the terminal scrollback.
func tokenCommand(args []string) error {
	fs := flag.NewFlagSet("token", flag.ContinueOnError)
	create := fs.Bool("create", false, "create a token")
	username := fs.String("username", "", "owner (default: first operator)")
	description := fs.String("description", "", "description shown in the panel")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if !*create || len(fs.Args()) != 0 {
		return errors.New("usage: x-ui-cli token -create [-username operator] [-description text]")
	}
	return withStore(func(ctx context.Context, store *repository.Store) error {
		users := service.NewUserService(store)
		owner := *username
		if owner == "" {
			first, err := users.First(ctx)
			if err != nil {
				return err
			}
			owner = first.Username
		}
		token, err := users.CreateToken(ctx, owner, 0, *description)
		if err != nil {
			return err
		}
		fmt.Println(token.Token)
		return nil
	})
}

func migrateCommand(args []string) error {
	fs := flag.NewFlagSet("migrate", flag.ExitOnError)
	var (
		status bool
		down   int
	)
	fs.BoolVar(&status, "status", false, "list migrations and whether they have been applied")
	fs.IntVar(&down, "down", 0, "roll back this many migrations, newest first")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))

	db, err := open(cfg)
	if err != nil {
		return err
	}
	defer database.Close(db)

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	switch {
	case status:
		migrations, err := database.Status(ctx, db, cfg.Database.MigrationsDir)
		if err != nil {
			return err
		}
		for _, m := range migrations {
			state := "pending"
			if m.Applied {
				state = time.Unix(m.AppliedAt, 0).Format("2006-01-02 15:04:05")
			}
			fmt.Printf("%d\t%s\t%s\n", m.Version, m.Name, state)
		}
		return nil

	case down > 0:
		fmt.Printf("This rolls back the last %d migration(s) and drops whatever they created.\n", down)
		if !confirm("Type y to continue: ") {
			fmt.Println("cancelled")
			return nil
		}
		return database.Rollback(ctx, db, cfg.Database.MigrationsDir, down)

	default:
		return database.Migrate(ctx, db, cfg.Database.MigrationsDir)
	}
}

func settingCommand(args []string) error {
	fs := flag.NewFlagSet("setting", flag.ExitOnError)
	var (
		show  bool
		reset bool
	)
	fs.BoolVar(&show, "show", false, "show the current settings")
	fs.BoolVar(&reset, "reset", false, "restore the settings to their defaults")
	if err := fs.Parse(args); err != nil {
		return err
	}

	return withStore(func(ctx context.Context, store *repository.Store) error {
		settings := service.NewSettingService(store)

		switch {
		case reset:
			fmt.Println("This restores every runtime setting to its default.")
			if !confirm("Type y to continue: ") {
				fmt.Println("cancelled")
				return nil
			}
			if err := settings.Reset(ctx, domain.ActorSystem, nil); err != nil {
				return err
			}
			fmt.Println("settings reset")
			return nil

		case show:
			values, err := settings.All(ctx)
			if err != nil {
				return err
			}
			keys := make([]string, 0, len(values))
			for key := range values {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				fmt.Printf("%s\t%s\n", key, values[key])
			}
			return nil

		default:
			fs.Usage()
			return errors.New("nothing to do: pass -show or -reset")
		}
	})
}

// backupCommand exports the panel's data, or replaces it from an export.
//
// It works against the database directly rather than through the API, because
// the case it exists for is a panel that will not start.
func backupCommand(args []string) error {
	fs := flag.NewFlagSet("backup", flag.ExitOnError)
	var (
		output  string
		exclude string
		restore string
	)
	fs.StringVar(&output, "output", "", "write the export here (use - for stdout)")
	fs.StringVar(&exclude, "exclude", "", "comma-separated tables to leave out, e.g. stats,changes")
	fs.StringVar(&restore, "restore", "", "replace the data with this export")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))

	db, err := open(cfg)
	if err != nil {
		return err
	}
	defer database.Close(db)

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	if restore != "" {
		fmt.Println("This replaces every table the export carries. Current data in those tables is lost.")
		if !confirm("Type y to continue: ") {
			fmt.Println("cancelled")
			return nil
		}
		file, err := os.Open(restore)
		if err != nil {
			return err
		}
		defer file.Close()

		backup, err := database.Import(ctx, db, file)
		if err != nil {
			return err
		}
		fmt.Printf("restored an export taken at %s\n", time.Unix(backup.TakenAt, 0).Format(time.RFC3339))
		return nil
	}

	var excluded []string
	for _, name := range strings.Split(exclude, ",") {
		if name = strings.TrimSpace(name); name != "" {
			excluded = append(excluded, name)
		}
	}

	backup, err := database.Export(ctx, db, excluded)
	if err != nil {
		return err
	}
	encoded, err := json.Marshal(backup)
	if err != nil {
		return err
	}

	if output == "" {
		output = fmt.Sprintf("%s_%s.backup.json", config.Name, time.Now().Format("20060102-150405"))
	}
	if output == "-" {
		_, err := os.Stdout.Write(encoded)
		return err
	}
	// 0600: an export carries every credential the panel holds.
	if err := os.WriteFile(output, encoded, 0o600); err != nil {
		return err
	}
	fmt.Printf("wrote %s (%d bytes)\n", output, len(encoded))
	return nil
}

// healthcheckCommand asks the panel whether it is serving. It talks to the
// configured address rather than to the database, because what a supervisor
// wants to know is whether requests are being answered.
func healthcheckCommand(args []string) error {
	fs := flag.NewFlagSet("healthcheck", flag.ExitOnError)
	timeout := fs.Duration("timeout", 5*time.Second, "how long to wait for an answer")
	subscription := fs.Bool("subscription", false, "also check the subscription HTTP listener")
	if err := fs.Parse(args); err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	if err := probe(ctx, cfg.Server); err != nil {
		return err
	}
	if *subscription && cfg.Subscription.Enabled {
		if err := probeSubscription(ctx, cfg.Subscription); err != nil {
			return err
		}
	}
	fmt.Println("ok")
	return nil
}

// probe asks the panel's listener for /healthz, and returns nil when it is
// answered with a 200.
//
// It is asked as the panel's own name when it has one, because the panel then
// refuses every other Host header, /healthz included. And the certificate is
// not checked: it is issued for the name the panel is reached by, which the
// address dialled here is not, and nothing is sent that needs keeping from
// anyone -- whether the listener answers is the whole question.
func probe(ctx context.Context, server config.ServerConfig) error {
	scheme := "http"
	if server.TLSEnabled() {
		scheme = "https"
	}
	host := server.Listen
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		// An empty listen means every interface, which is not an address to
		// connect to.
		host = "127.0.0.1"
	}
	url := fmt.Sprintf("%s://%s/healthz", scheme, net.JoinHostPort(strings.Trim(host, "[]"), fmt.Sprint(server.Port)))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if server.Domain != "" {
		req.Host = server.Domain
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", url, res.Status)
	}
	return nil
}

func probeSubscription(ctx context.Context, subscription config.SubscriptionConfig) error {
	host := subscription.Listen
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if subscription.CertFile != "" && subscription.KeyFile != "" {
		scheme = "https"
	}
	// An intentionally absent subscription verifies the HTTP listener without
	// creating a client or exercising any inbound.
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, scheme+"://"+net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(subscription.Port))+subscription.Base()+"x-ui-install-probe", nil)
	if err != nil {
		return err
	}
	request.Host = subscription.Domain
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("subscription listener: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotFound && response.StatusCode != http.StatusOK {
		return fmt.Errorf("subscription listener returned HTTP %d", response.StatusCode)
	}
	return nil
}

// withStore loads the configuration, opens the database and hands a store to
// fn. Every subcommand that touches data goes through it, so none of them has
// to repeat the setup or remember to close the pool.
func withStore(fn func(context.Context, *repository.Store) error) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	logger.InitLogger(logger.ParseLevel(cfg.Log.Level))

	db, err := open(cfg)
	if err != nil {
		return err
	}
	defer database.Close(db)

	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	if err := database.Ping(ctx, db); err != nil {
		return err
	}
	return fn(ctx, repository.NewStore(db))
}

func open(cfg *config.Config) (*gorm.DB, error) {
	return database.Open(cfg.Database, cfg.Log.Debug())
}

// confirm asks before an irreversible change. It returns false when there is
// no terminal to ask on, so a script that reaches this by accident stops
// rather than proceeding unattended.
func confirm(prompt string) bool {
	fmt.Print(prompt)
	answer, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		fmt.Println()
		return false
	}
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes"
}

func orNever(value string) string {
	if value == "" {
		return "never"
	}
	return value
}

func onOff(on bool) string {
	if on {
		return "on"
	}
	return "off"
}
