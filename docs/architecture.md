# Architecture

x-ui is the control plane for a tunnel deployment. It stores the
operators who run it, the subscribers who use it, the listeners they connect
through, and the traffic counted against both — and it enforces quotas and
expiry on a schedule.

It does not carry traffic. The proxy core is a separate process on a separate
host; x-ui tells it what to serve and receives what it measured. That
boundary is what makes the panel restartable, upgradeable and horizontally
scalable without anyone's connection dropping.

## Terminology

The project says **sign in**, **sign up** and **sign out** — never log in,
register or log out. One word per concept, everywhere: identifiers, routes,
JSON fields, columns, log lines and prose. A codebase that calls the same thing
two names makes every search for it miss half the results.

Endpoint paths spell the term as one word — `signin`, `signup`, `signout` —
while everything else uses the shape its own language calls for: `SignIn` in Go,
`last_sign_in` in SQL, "sign-in" in prose. The path is the one place the reader
is typing rather than reading, and a hyphen there is a thing to get wrong.

| Concept | Term | Endpoint | Elsewhere |
|---|---|---|---|
| Authenticating an existing operator | sign in | `POST …/signin` | `SignIn`, `SignedInUser`, `last_sign_in` |
| Creating an account | sign up | `POST …/signup` | — |
| Ending a session | sign out | `POST …/signout` | `signOut`, `ClearSession` |

Sign-up has neither an endpoint nor an implementation; the path above is
reserved, not served. The panel has no self-service account creation:
the first account comes from `x-ui-cli seed`, from the environment at
startup, or from `x-ui-cli admin`, and later ones from an existing
operator. The term is fixed here so that whenever it is built, it is not called
registration.

## Layers

Dependencies point one way, downwards. A layer knows the one below it and
nothing above.

```
cmd/api          cmd/worker        cmd/cli        process entry points
     │                │                │          wiring, signals, lifecycle
     ▼                ▼                ▼
internal/handler      │                │          HTTP: bind, authorise, respond
     │                │                │
     ▼                ▼                ▼
internal/service ─────┴────────────────┘          business rules, transactions, audit
     │
     ▼
internal/repository                               queries; one type per aggregate
     │
     ▼
internal/database  ──▶  PostgreSQL                connection, pool, migrations
     │
     ▼
internal/domain                                   entities, invariants, error vocabulary
```

`pkg/` sits beside all of it and depends on none of it: `logger`, `httputil`
(the response envelope) and `validator` are generic enough to be lifted into
another service unchanged.

### Why the split

The reference implementation this is modelled on mixes business rules and SQL
in one `service` package: a service method opens a `*gorm.DB`, builds a query,
applies a rule and writes the result. That is compact, and it works — but it
means every rule is testable only against a live database, and the ORM appears
in the signature of functions that have nothing to do with storage.

Splitting them costs a file per aggregate and buys two things. Rules become
testable without a database (see `internal/domain/client_test.go`, which covers
the whole quota and expiry state machine and touches nothing). And a query
lives in exactly one place, so the column list a listing selects is not
duplicated across the three call sites that happen to need it.

### Error vocabulary

Repositories and services speak in sentinels from `internal/domain`:
`ErrNotFound`, `ErrConflict`, `ErrInvalid`, `ErrUnauthorized`, `ErrForbidden`.
They wrap with `%w`, so context is added without losing the kind:

```go
return domain.NotFoundf("client %d", id)
```

`internal/handler.fail` is the only function that knows what those mean over
HTTP. That is what lets a repository say "not found" without importing gin, and
it is why an unrecognised error becomes a bare 500 with the detail in the log:
a database error's text names tables, paths, and sometimes the DSN.

Validation is the one structured case. `pkg/validator` collects every failing
field in one pass rather than returning at the first, and the handler renders
the list — so a client filling in a form is told about all of it at once
instead of one field per round trip.

## Transactions

`repository.Store` bundles every repository over one connection and hands out a
transaction-scoped copy of itself:

```go
err := s.store.Tx(ctx, func(tx *repository.Store) error {
    if err := tx.Clients.Delete(ctx, id); err != nil {
        return err
    }
    return recordChange(ctx, tx, actor, "clients", "del", clientRef(client))
})
```

The change and the audit entry that explains it commit together or not at all.
Nesting is safe — GORM turns an inner transaction into a savepoint — so a
service that calls another service's transactional method still commits once.

## Data model

Eight tables, created by `migrations/001_init.up.sql`:

| Table | Holds |
|---|---|
| `users` | Panel operators. Passwords are bcrypt; `totp_secret` holds the authenticator secret while two-factor authentication is on. |
| `tokens` | API tokens, cascading from their owner. |
| `clients` | Subscribers: quota, expiry, traffic counters. |
| `inbounds` | Listeners. Known fields in columns, everything else — the TLS each terminates with among it — in `options` (jsonb). |
| `outbounds` | Routes out of the node, stored the same way, WireGuard tunnels among them. Seeded with `direct` and `block`. |
| `settings` | Runtime options, as key/value — including the base configuration document. |
| `stats`, `changes` | Traffic buckets and the audit log. |

### The two tagged types

An outbound is a row of an id, a type, a tag and an options blob, and an
inbound is that plus the fields the panel reasons about. The outbound's
marshalling is written in `domain/tagged.go`, apart from the type, and its
repository as a generic over the row in `repository/tagged_repository.go`; the
whole point of the blob is that nothing between the request and the generated
config touches it.

They stay separate types and separate tables: they are separate things to the
core and to an operator, and a tag only has to be unique among its own kind. The
service layer is *not* generalised — doing so would need accessor interfaces on
every type, which costs more than the duplication saves.

## The generated configuration

A node does not hold its own configuration; it fetches one. `GET /api/config`
assembles that document on read, from two sources:

- the **base document**, which an operator edits at `/api/config/base` and which
  holds everything that is not an object the panel models — `log`, `dns`,
  `route`, `experimental`, HTTP clients, and the
  auxiliary `services` a node runs, which the panel does not model;
- the **modelled objects** — `inbounds` and `outbounds` — read from their
  tables and rendered into the core's own shape, the WireGuard outbounds into
  `endpoints`, the one place the core runs WireGuard.

Assembling on read rather than storing the result means a node always gets what
the database says now. Nothing has to remember to regenerate.

Two rules keep the seam honest. The base document refuses every managed key
outright — generation overwrites them either way, so accepting them would store
something that reads back as though it had taken effect. And `domain.CoreConfig`
lists **every** top-level key the core accepts: a key missing from that struct
is silently dropped on the way through, taking with it whatever the operator
wrote by hand. There is a test asserting that every entry in
`ManagedConfigKeys` has a field to be written into — a managed key with no field
would be refused on save and never appear in the output either, unreachable from
both ends.

An outbound is the one object with a floor: deleting the last one is refused,
because a configuration with inbounds and no outbounds routes nothing and the
core will not start on it.

A block route is the one outbound whose options the API judges. It refuses every
connection sent to it and takes nothing but its type and its tag, and the core
refuses a configuration over any key it does not read — the whole configuration,
not the one route — so an option left on a block route would stop every node at
its next sync. Each such option is refused on the write instead, by name, as a
field is. Every other type's options stay the core's to judge: they differ from
one release of it to the next. The core now prefers a rule's reject action for
refusing what the rule matches, which needs no route out; a block route is still
what anything that can only name a route out — the default outbound above all —
is pointed at to refuse. So a panel starts with one, tagged `block`, beside
`direct`. It is seeded after `direct`, never first: the core sends whatever no
rule matched through the first route out unless the base document names
another, and a block route there would refuse all of it.

A WireGuard route is the other outbound the API judges, and the one it moves.
The core has run WireGuard as an endpoint since 1.11 and refused it among its
outbounds since 1.13, so a `wireguard` outbound is stored with the options the
core's WireGuard endpoint takes — its addresses, its private key, its peer with
the far end's address and port — and written into `endpoints` rather than
`outbounds`, where a rule, a detour or the default outbound names it by its tag
as it names any outbound. The keys only the old WireGuard outbound took
(`server`, `server_port`, `local_address`, `peer_public_key` and the rest) are
refused on the write by name, as a block route's options are. The panel keeps no
other kind of endpoint.

Services are not modelled at all. The auxiliary services a node runs — DERP
relays, resolvers, SSM APIs — are the base document's `services` key, like any
other key the panel does not model, passed through to the node as it is
written.

A listener carries its own TLS: `tls` is one of its options — the block the core
terminates with, plain TLS or Reality — and is written into the generated
document as it is. What a client is handed to meet it — the uTLS fingerprint,
the Reality public key, whether to verify at all — is no option the core takes
on a listener, and the core refuses a configuration over a key it does not read,
so it is kept apart, under the same key in the listener's `out_json`, beside the
rest of what a client is told. Links and subscriptions read both halves; the
node sees only the first. The API refuses a `tls` that is not an object, and
drops a `tls_id` — the reference's pointer to a TLS configuration kept apart —
which the core would refuse.

### Users

Every inbound that authenticates is rendered with its `users`: the enabled
subscribers assigned to it, each as the identity they hold for its protocol, the
way the reference fills them in when it assembles its core's configuration. The
listing is what enforcement acts through — a subscriber the worker disables for
running out of quota or time drops out of every listener's users, and so off
every node at its next sync. It is ordered by subscriber, so the document reads
the same on every fetch until something in it changes.

A few protocols need more than the identity copied across. Shadowsocks takes the
identity its method needs, and a 2022 method only a key of the length it reads;
a shadowtls listener has users from version 3 only; a mixed listener takes a
subscriber's socks and http identities both, since each of their links is
dialled at it; and a vless flow of vision is dropped where the listener has no
TLS switched on — Reality counts — or a transport in between. A user carries only the fields its protocol
takes. A subscriber whose user cannot be built — no identity for the protocol,
an unreadable config, a key the method cannot use — is left out and logged,
rather than handing the node a configuration its core refuses whole.

A listener nobody may use gets no `users` key at all. For snell that is the one
key everyone shares, as it was before snell took a key each; socks, http and
naive, though, let anybody in when they have no users, so a listener of those
whose subscribers are all disabled is open until one is enabled again, as the
reference's is.

### Maintenance

Maintenance is a boolean in the settings, and generation is where it means
something. With it on, the document comes back with **no inbounds** — the
listeners are simply not there — while outbounds, the WireGuard ones among the
endpoints, and everything the base document carries are assembled as usual.

That choice follows from where the panel sits. It holds no connection to a
node and cannot reach into one to stop it; what it controls is the document
the node fetches. Withholding the listeners is therefore the only instruction
it can give that a core actually obeys, and it is one a core obeys completely:
nothing is listening, so nothing connects.

Leaving the rest of the document intact is what makes it reversible. Routing
stays whole, the tags an inbound would have referred to are still there, and
turning maintenance off serves exactly the listeners that were being served
before — there is no rebuild step and nothing to remember.

An empty `inbounds` is also, read literally, a perfectly ordinary
configuration: a deployment that happens to serve nothing. The agent would log
it as such, which is the wrong thing to tell whoever reads that log at three in
the morning. So the response carries a header saying the emptiness was
deliberate:

```
X-UI-Maintenance: true
```

`internal/agent` reads it into `NodeConfig.Maintenance` and warns in its own
words — the panel is in maintenance, this node is now serving no listeners —
rather than reporting an empty deployment. The header is the only channel for
it: `/api/config/download` returns the bare document, because the core parses
that response and an envelope would not survive.

The same flag comes back on every aggregate poll, so a panel that is already
open finds out that maintenance was switched on elsewhere.

## The aggregate poll

`GET /api/load?lu=<cursor>` returns everything the panel renders in one
response, and a short reply when nothing has changed. The alternative is a front
end polling eight endpoints and diffing them: more requests, more round trips,
and no cheap way to ask whether anything happened at all.

The cursor is the **highest audit-log id**, read from the database. Two details
there are deliberate:

- **An id, not a timestamp.** It is strictly monotonic, so two changes in the
  same second are still distinguishable, and it cannot go backwards if the
  host's clock does.
- **From the database, not from memory.** The reference implementation keeps a
  package-level `LastUpdate`, which works because it is one process. x-ui
  is two: the worker disabling a depleted client is exactly the kind of change
  the panel has to notice, and an in-process counter in the API would never
  hear about it.

`onlines` and the maintenance flag are returned on *every* poll, changed or not.
They are what moves between changes, and they are why a poll that found nothing
still returns something worth having.

The client list is capped. Everything else in a snapshot is configuration an
operator wrote and there is never much of it; clients are the one collection
that grows without bound, and past the cap the paged listing is the right
endpoint.

## The panel

`web` is a React application — TypeScript, Vite, React Router, SWR over
Axios, React Hook Form with Zod, Tailwind and the shared design system. It is
built into `web/build` and served by `cmd/api` itself: `mountWebUI` serves
that directory when it exists and otherwise says so in the log and serves the
API alone. Nothing about the server depends on the panel being there, and there
is no second thing to serve in its place — a shell that only announces the panel
is missing tells an operator nothing the log did not.

It is served as files beside the binary rather than embedded in it. Embedding
would mean a Go build that needs npm and a panel that cannot be rebuilt or
dropped without relinking the server; neither is worth the single-file deploy
it buys.

The panel is served from the root, and every path that is not the API's,
`/healthz` or an asset falls through to `index.html`, because the routes are the
application's, not the server's — a reload of `/clients` has to land on the
clients page and not a 404. The router is given the same base, so the path the
server mounts at and the path the router reads are one setting, not two that
have to agree.

The features are laid out one directory per thing an operator does — overview,
inbounds, clients, outbounds, general, audit — each with its own `api` module
holding the endpoints, the Zod schemas and the SWR hooks for exactly that
feature. What a feature talks to is next to what it renders, and the shared
layer underneath is only what is genuinely shared: the Axios instance and
envelope unwrapping, the SWR defaults, the router, the auth provider, the theme
store.

The layout is the s-ui frontend's: a rail against the left edge, an app bar
across the top, and the page in the room the two leave. The rail is 56 pixels of
icons, and the button at the head of the app bar expands it to 256 and collapses
it back again; nothing else changes its width. The reference widens its rail over
the page while the pointer is on it, but here neither the pointer nor the
keyboard reaching the rail does, so it never lies over the page: expanded, it
moves the page along to make room, and collapsed, its icons are still read out by
the labels it cuts off. The choice is kept in the browser, as the theme is. The
reference keeps the room for that button but has nothing in it. Below 840 pixels
there is no room even for the icons, and the rail becomes a drawer the button
brings out instead and a picked page puts away.
The app bar says which page is open, carries a badge on every page while
maintenance is on — the flag outlives a restart, and a panel serving nobody looks
like any other from wherever an operator is — and holds the theme. The sizes and
the behaviour are taken from the reference; the colours, the type and the
components are the design system's, so both schemes still come from one place.

The shell that draws this is the layout route every signed-in page renders
inside, not a component each page wraps itself in. It stays mounted while pages
change beneath it, so the rail keeps whatever state it was left in and the live
poll is started once; and the title the app bar shows is read off the route that
matched, so a page holds what it shows and the name it goes by stays beside its
path in the route table.

The rail names every page the panel is worked in, in the reference's order, which
is the order traffic moves through them: what arrives and what it is encrypted
with, who it belongs to, where it goes out, how the core itself is set up, which
way it is routed and how the names it is sent to are resolved, then, under
General, the pages about the panel and shared node settings. It uses the
words the API and the proxy core's own configuration use —
inbounds, outbounds, clients — rather than readings of them, because an operator
arrives here from that documentation and a friendlier rail left them
translating. Audit is reachable at its path but not from the rail: it is read
when something is being looked into rather than as part of the work.

An entry is a page rather than a table, and the pages are the reference's. The
reference gives its TLS configurations a page of their own; here a listener
carries its own TLS, chosen in its dialog, so there are no configurations to
keep. The reference also gives the tunnels a
node is one end of a page of endpoints, and the auxiliary services it runs a page
of their own; the panel keeps WireGuard tunnels alone, as routes out, so they are
on the outbounds page, and keeps no services. A rail that grew an entry per table
would be a list of the database rather than of the work.

Under General in the rail are the admins and the settings. The settings page holds what an
operator sets about the panel and nodes -- how subscribers are served, their own
second factor, where the panel's notifications go, how nodes keep time and
download remote resources, the interfaces a node's core serves that the panel's
agent reads traffic through, what the nodes' cores log
-- and shows what they cannot set from here: the panel's own listener as the
process read it, and the configuration the nodes are handed. Backups are not
under General: they are taken and put back from the overview, where the
reference keeps them. Nor is the base document as a whole: rules and DNS are
edited on their own pages, while NTP, HTTP clients, the core's log and its
experimental interfaces are edited on separate settings tabs. Each writes the
document back whole with only its own key changed. The operators' page stands with the settings, as the reference's admins
do, because who can sign in is about the panel too, and it is what the account
and API token pages under General became. It keeps the reference's `/admins`
rather than moving under `/general`, so the rail's grouping is the rail's
alone. The two are in the reference's order.

General is a heading that folds its pages away and brings them back. It starts
open, so every page is still a single press away, and a fold is kept in the
browser, as the rail's width is. Each of its pages keeps its own row and icon
rather than being reached through a menu off the heading, because a collapsed
rail is a column of icons: there the heading is one more icon above theirs, and
widened, the rail sets them in under it. Folded over the page that is open, the
heading is marked in its place. `/general` on its own leads to the settings,
and so does `/settings`; `/general/subscriptions`, where the subscription's
options had a page of their own for a while, leads to their tab. The old
`/basics` address leads to the NTP tab, beside the HTTP Clients tab. The addresses
the operator's account and the API tokens used to have under General lead to the
admins page.

The admins page is the reference's: the change log and the API tokens, each
opened in a dialog, centred over a card for every operator saying when and from
where it was last signed in to. A card opens that operator's own changes, which
the API narrows the log to. Only the operator's own card offers to change
credentials, since the API changes those of the session asking and no other,
and none offers to add or remove an operator: accounts are made with
`x-ui-cli admin`. The credentials are changed in the reference's narrow
dialog of filled fields, with the username carried in and the new password asked
for twice, which the reference does not ask: it is not shown, and a typo would
lock the operator out. A change ends the session, so the dialog leaves for sign
in, as signing out does. The last sign-in is shown as the API wrote it, with the
clock it was written by, rather than read as a moment in the browser's time
zone that it never said it was in.

The settings page is the reference's card with its tabs centred across the top:
Panel, Subscription, Two-factor authentication, Telegram Bot, Sing Box, NTP,
HTTP Clients, Experimental and Logs. The open tab is kept in the address (`?tab=`), so a
reload or a link lands on it. Where there is not the room for every tab -- on a
phone -- the row scrolls rather than squeezing their names together, and the
open one is brought into view. Each tab acts on its own, so each has its buttons
along the foot of the card under a line, Save last, where a dialog keeps it,
rather than the page having one Save above every tab, as the reference's has:
the subscription's options and the bot's are saved and put back apart -- a
tab's Restore defaults names its own keys to `/settings/reset`, so putting the
subscription back does not forget the bot's token -- NTP, HTTP clients, the
experimental interfaces and the log are each saved into the base document.
Sing Box is read-only; two-factor authentication belongs to the
signed-in operator.

- **Panel** is the reference's interface tab, edited and saved: the
  panel's own address, port, path, domain and certificate, the session's
  length, how long traffic is kept and in what buckets, the worker's schedules
  and time zone, the trusted proxies and the log level. `/settings/panel` reads
  saved and API startup values separately. Its POST accepts only the typed
  Panel fields and the file revision the draft started from. It validates the
  candidate, preserves other YAML fields and comments, and replaces the file
  atomically with its existing permissions. Environment overrides are locked;
  stale saves are refused. The API and worker are restarted by whatever runs
  them to apply changes. Relative assets and a server-supplied document base
  keep the router and API aligned with an edited Web path. It says so when
  no session secret is configured, since every session then ends with the
  process.
- **Subscription** is where subscribers fetch it and how often their
  applications fetch it again along the top, the address given the room it
  needs, how it is written for them under that, and under those the
  subscription listener as the configuration sets it. The address is set there
  too, so it is shown rather than changed. The reference's tabs of extensions
  to the JSON and Clash subscriptions are left out: this panel renders those
  without any.
- **Two-factor authentication** is the signed-in operator's own, as their
  credentials are; another operator's is theirs to turn on. Turning it on is
  three steps in one place -- a QR code of the secret (or the secret itself, in
  the groups of four an app shows it in), then a code from the app typed back,
  which proves the app holds the secret before sign-in depends on it. Turning it
  off takes a code too. Each operator's card on the admins page says whether
  theirs is on.
- **Telegram Bot** is the bot's token and chats, whether it sends at all, and
  which events it sends about; *Send a test message* tries the bot as it is
  saved. See [Notifications](#notifications).
- **Sing Box** is the configuration every node fetches (`GET /config`),
  assembled now and shown read-only, to copy or to download for a node set up by
  hand. It says so when maintenance is withholding the listeners from it.
- **NTP** edits the base document's `ntp` key. Switching the clock off removes
  that key; switching it on starts with a server, port and interval. Other NTP
  options already in the document remain when these fields are edited.
- **HTTP Clients** edits the base document's `http_clients` key independently.
  The table names shared clients, their HTTP version, engine and detour; its
  dialog carries other options through as JSON. An empty list removes the key.
- **Experimental** is the interfaces every node's core serves beside the proxy
  -- its cache file, the Clash API and the V2Ray API -- the base document's
  `experimental` key, edited as a copy and written back whole with only that key
  changed, as NTP and HTTP Clients do with their own keys. Each interface is a group of
  fields under its heading, switched on where the reference starts one and
  taken out of the document whole when it is switched off. The Clash API is the
  one the panel itself depends on: a node's agent reads the traffic it reports
  from it, so a node with it off reports none, which the tab says under the
  switch while it is off. There is no Restore defaults: the default is every
  interface off, the Clash API among them.
- **Logs** is what every node's core logs -- whether it logs at all, how much,
  where to, and whether each line is stamped with the time -- the base
  document's `log` key, edited as the experimental interfaces are, and with
  only a Save as they have. It is the nodes' log rather than the panel's, which
  the tab says: what the panel itself has been saying is read from the
  overview, and how much it says is saved through the Panel tab into
  `configs/config.yaml` and applied on restart.

The reference has no two-factor authentication, Telegram bot or generated
configuration on its settings page; those three tabs are this panel's own. It
keeps the core's log and experimental interfaces on its basics page, and so did
this panel, until they moved here; each is edited in one place, so no two pages
write the same key. Nor
is maintenance, which the reference's settings stop the core for, switched
here: it is about every listener rather than a setting of the panel's, and the
overview is where it is switched and where the app bar's badge leads.

The overview is the reference's home page: the panel's mark, a row of the few
things it can be asked for — the tile picker, backup and restore, the log, the
counts — and under them a grid of tiles an operator picks. None of the four is a
page of its own because none of them is worked in: a log is read until the
question is answered and a backup is taken and saved, so they are dialogs over
the tiles, which carry on polling behind them. A backup is saved by the browser,
without the traffic history and the change log unless they are asked for. A
file to restore from is read in the browser first, so one that is not JSON never
reaches an endpoint that replaces every table, and then goes up as the file
field the API reads a restore from.

A tile is one reading in a box of a fixed height: a dial, a chart of the last
twenty readings, or a panel of figures. Which ones are showing is kept in the
browser rather than on the panel — what one operator wants to watch is not what
the next one does, and the reading behind a tile is the same for everyone — and
they are held in the picker's own order, so a tile switched off and on again
comes back where it was. Every tile is on until somebody turns one off: an
overview that started empty would be read as a panel that knows nothing rather
than as one that was never asked.

The charts are drawn from readings the browser kept, not from a series the API
holds: `/system` answers with what is happening now and remembers nothing, so a
chart starts empty on every visit and one of a rate stays empty until a second
reading arrives to measure the first against. How long that took is read off the
process's own uptime rather than a clock, so the rate is right whatever the poll
interval is.

Maintenance is switched from the panel tile, beside the badge that says whether
the panel is serving. The reference also stops its core from its settings page,
which here leaves maintenance to the overview. It is asked about before it is done, because the effect —
every listener withheld from the configuration the nodes fetch — is delayed by a
sync interval and is invisible from here. While maintenance is on, that tile is
shown whether or not it was picked: the app bar says maintenance is on from every
page and leads here, and an overview with the tile switched off would have
nothing to say about it and no way to end it.

The inbounds page is the reference's as well: the one button that adds a
listener, centred over a grid of cards that is six across on a wide screen, four
on a laptop, three on a tablet and one on a phone. A card is the listener's tag
with its type under it, where it binds, how it is served -- in the clear, over
TLS or over Reality, read off the TLS block it carries -- how many subscribers
may connect through it and whether it has moved traffic lately, and a row of
round buttons along its foot: edit, delete, clone and the traffic chart.
Deleting is asked on the card itself rather than over the page, and says what it
costs the subscribers connecting through it. Cloning writes the copy straight
away, its TLS with it, under the type and a few random characters and on a random
port between 10000 and 60000 — the two things the API and a node would refuse a
second of — and leaves the subscribers behind, since they name the listeners they
use rather than the other way round. That is also why the count on a card is
read off the subscribers: the API answers a listener without them, and a listing
longer than one read holds gives a count that is only how many there are at
least, which the card says with a plus.

The outbounds page is the same grid of the same cards, which are written once in
`src/components` for every page that lists tagged objects: where a route sends
traffic, whether it wraps it in TLS, whether anything has gone out through it
lately, and edit, delete and the traffic chart along the foot. The reference also
measures how long each far end takes to answer, one at a time or all at once, and
imports a batch of routes from links; the panel runs no proxy core to measure
with and the API takes routes one at a time, so neither is offered.

A route out through WireGuard is one of the cards, as it is one of the outbounds
the API keeps, and says where it sends the way the rest do: its server and port
are its peer's, the far end of the tunnel. The core runs it as an endpoint and
reports its traffic under its tag as it reports a route out's, so the chart and
the online badge read it the same way. The reference keeps WireGuard among its
endpoints, on a page of its own with the other tunnels a node can be one end of;
the panel keeps no other kind, so there is no such page.

The clients page follows the reference as well: Add, a menu of what is done to
every subscriber at once and the filter, centred over a table in its eleven
columns — the name, a switch for whether they may connect, the description and
group, how many listeners they may use, the row's actions, the quota spent
against what they have with a bar under it, the days left, whether they are
online, and when they were added and last seen. Below 840 pixels a row stacks
into a line per column, with a select standing in for the headers that ordered
it. What stays the panel's own is where the narrowing and the paging happen: the
API does both, so the filter is applied rather than typed into, and the
reference's expired and online filters, which it works out in the browser from
every subscriber it holds, are not offered. Neither are its bulk add and edit,
which the API has no way to take other than a request per subscriber that can
stop halfway. Switching a subscriber off from the row reads their record afresh
and writes it back whole, and resetting one subscriber's traffic lives in their
edit dialog, where the reference keeps it too.

The listing carries each subscriber's listener ids for that table, and for the
edit opened from a row: the API replaces the set it is sent rather than merging
it, so a listing without them was an edit that cut the subscriber off from every
listener. Their credentials stay out of it.

Adding and editing a subscriber happen in the reference's dialog, in its three
tabs. The first holds who they are and what they have, in the reference's rows:
whether they may connect and their group, their name, description and remark,
their quota and expiry, whether their clock waits for their first byte and
whether their quota repeats, with the days either asks for, and the listeners
they connect through as chips in one field across the foot. Editing, it also
says what they have spent, with the button that hands their quota back beside
it. The second holds their credentials, one identity per protocol, drawn in the
browser as the reference draws them and in the shapes the API mints its own in:
a new subscriber is given one of each as the dialog opens, and starting one
afresh, or all of them, draws another at once. None is put into use before the
save. One left empty is still the API's to mint on the save, for the listeners
that need it, and one can be typed in for a subscriber moved here whose client
applications already hold theirs. The third lists the
links the API builds for them. The reference also keeps links from elsewhere
there; the API has nowhere to keep them, so they are not offered.

Because the credentials are sent back whole, an edit is made from the subscriber
read on their own rather than from the row it was opened from: the listing
leaves the credentials out, and a save without them would have the API mint new
ones and cut off every client application holding the old. Until that read has
answered, there is nothing to save; a form that never held the credentials
leaves them out of what it sends, and the API keeps its own.

The Name field remains editable. Saving a rename keeps the subscriber's id,
listener assignments, UUIDs, passwords and traffic counters. The API updates
identity names to match. Since the subscription URL contains the name, the edit
dialog explains that client applications need the new subscription address after
saving.

The DNS page is the reference's too, and the first built on the base document
rather than on an object the API models. A node's DNS is the `dns` key of that
document, so the page edits a copy of that key and writes the document back whole
when Save is pressed, with everything else in it as it came; nothing reaches a
node before then, and leaving the page drops the copy. Along the top are the
buttons that add a server or a rule and Save, faded out until the copy differs
from what was read. Under them are the settings that apply to every query, in
the reference's filled fields, which are written once in `src/components` and
shared with the other settings pages and the sign-in form; there each field
keeps the reference's line under it for what is missing from it, so the form
does not move when something is. Then come the servers and the rules as the
same cards the listeners use, a rule known by its place in the order since it
has no name. The rules are put in order by dragging one card onto another, as in
the reference, and from a rule's dialog as well, since a drag is not something a
keyboard can do. A server's tag is set once, as a route's is, because rules and
the final server name it; a server deleted out from under a rule leaves the rule
saying so rather than pointing it somewhere else.

The rules page is the same arrangement over the document's `route` key: the
settings every connection is routed by, then the rule sets as cards, then the
rules in the order they are checked, all saved together. Beside the button that
adds a rule are the reference's tools. One imports the rules and rule sets of a
pasted configuration, after the page's own or in their place.
Another adds remote rule sets from a list of addresses. The third picks from the
reference's ready-made rule sets, with a rule sending them to one route out if
wanted. They change the copy on the page like anything else. The reference can
also read a file or fetch an address for its imports; a file's contents can be
pasted, and a browser fetching an arbitrary address is refused by most hosts, so
neither is offered. What the two pages share about a rule -- how its kind is
named, what its conditions are counted as, how it is moved, what it can match
on -- is written once in `src/lib/rules.ts`.

A rule is written in the reference's dialog: whether it combines other rules,
what it matches -- the groups of conditions the reference switches on from a
menu, in a block, or a block for each rule it combines -- then its action,
whether it combines them with and or or, whether it is inverted, and a block for
what the action takes. The conditions block is written once in `src/components`
for both kinds of rule. The rule's place in the order is asked beside the first
switch, where the reference leaves room, since a drag is not something a
keyboard can do; the reference's larger editor for a long list is not offered,
as the list's own field can be pulled taller instead. An existing rule set's edit
dialog is the reference's too: its kind, tag and format, then a local one's path
or where a remote one is fetched from, over which shared client or route out and
how many days apart. An inline rule set, which the reference does not offer,
has its rules typed out as the document they are.

A DNS rule is written in the same dialog, over the groups of conditions a query
can be matched on, with the reference's blocks for what its actions take: the
server a query is sent to and how it is resolved, what a rejection does, and the
answer a predefined rule gives, whose records are only asked for while it is not
an error. A DNS server's dialog is the reference's, set in from its edges as the
reference's is: its type and tag, where a server asked over the network is asked
and at what path, how it dials, and a row for what the type asks besides --
whether a local server prefers Go's resolver, the interface a DHCP one asks on,
the ranges a fake-IP one hands out. The reference's Tailscale and resolved
servers, answered through a Tailscale endpoint and a resolved service, are not
offered, as the panel keeps neither for one to name. A hosts server's own names
are a block of rows, a name to a row. What a server asked over TLS or HTTP is
asked with -- the reference's TLS and headers blocks -- is typed out as the
document it is stored as, in a block named for the type.

NTP and HTTP Clients are separate settings tabs over two keys of the base
document that describe the node's core rather than its traffic. Each tab has its
own Save and changes only its own key. A clock switched off and an emptied list
of clients are taken out of the document rather than written empty. The
reference keeps the core's log and experimental interfaces on its basics page;
those too are separate settings tabs here. The reference also sets how the
clock dials out; that is left as the document has it.

There is no page of TLS configurations: a listener's TLS is written in its own
dialog, in the block where the reference picks a configuration for it. The block
opens on a Security choice -- None, TLS or Reality -- and holds the fields of
whichever is chosen, laid out as the reference lays out its TLS dialog: for TLS,
where the certificate comes from, a path to it or its text, and
what a client is told about verifying it; for Reality, the handshake it borrows,
its keys and short ids -- with the reference's groups of options switched on
from the block's foot, and for TLS a block under it for encrypted client hellos,
which the core refuses beside Reality. Choosing another starts it afresh, as the
reference's toggle between the two kinds does, and None takes the block out.
Every field reads off one of the listener's two halves -- its `tls` option and
its `out_json.tls` -- and writes back into it, so whatever the core accepts that
has no field is carried through an edit as it was. The API generates a
self-signed certificate and a Reality key pair for the buttons beside those
fields, as the reference's does; it has nothing that generates an ECH key, so
that button is not offered. The key-pair call is written once in `src/lib`, for
the WireGuard route out's keys as well.

An existing listener's tag is editable. Its id and client assignments stay the
same; the edit updates route and DNS inbound conditions, other listeners'
top-level detours, configured inbound statistics selectors, and traffic history
in one transaction. Former names are reserved against the listener's stable id
in `inbound_tag_aliases`, so delayed reports resolve to its current tag even
after several renames. Reserved names cannot be assigned to another listener,
including after deletion. Tag edits take an exclusive transaction advisory
lock before row locks; traffic ingestion takes its shared counterpart before
resolving aliases and adding samples. Outbound edits use the same lock order.

Listeners are written from the panel, and the shape of that is worth recording
because the record is only half modelled. Three fields — type, tag and the id the
API assigns — are the panel's; everything else an inbound carries is an option
the proxy core accepts for that listener type, which differs per type and grows
with each core release. So the form has fields for the three and carries the rest
through as the JSON document it is stored as.

That is not a placeholder for a richer form. A form built from the options of
the types known today would drop every option it did not have a field for on the
first save, and for most listener types that is all of them — the panel would
quietly break the configurations it was opened to edit. Round-tripping the
document is what makes an edit lossless, and it is tested as such. The named
fields are spread over the document on the way out, so a `tag` inside the JSON
cannot move the row being edited somewhere else.

On the listener form that document is held rather than shown: it lives in the
form's values with no field rendering it, and is handed back on submit. Editing
raw JSON is not what an operator opens that dialog to do, and the options they
do set have fields of their own. The document is still what makes the save
lossless, which leaves the round trip resting on something nothing on screen
would miss — take it out of the form's defaults and every save writes a listener
stripped to its four fields, its TLS gone with the rest — so it is asserted
against the record the API holds rather than against the dialog. The outbound dialog still edits its own directly,
beside the fields read off it: a route out is written from scratch far more
often than it is amended, and there is nothing else to fill it in with.

An option earns a field of its own when it is on nearly every listener type and
is one an operator sets often, which is why `listen` and `listen_port` have one:
without it, nothing in the panel could change a port at all. The TLS is not one
of them: its fields are views over the document rather than beside it, and the
Security choice is held beside the document only so the form can say under it
what the core would refuse. They are left out
of the payload when empty rather than written as `""` and `0`, because a type
that binds nothing — tun, cloudflared — carries neither key, and inventing them
would put configuration on a node the core never had. The type is chosen from a
list for a different reason: it is one word the core refuses at startup if it is
misspelled, and the list is what the form offers rather than what it accepts, so
a record carrying a newer core's type is still editable.

The dialog itself is the reference's, for adding and editing alike: its title
with a link to the core's documentation for the chosen type, the type and the
tag three to a row, then the reference's blocks — where the listener binds,
except on a type that binds nothing, and how it is served, on a type that can be
served over TLS. A type that is only ever served over TLS is refused in the
clear, as the reference refuses it without a configuration, and one served over
QUIC — hysteria, hysteria2, tuic and naive's HTTP/3 — is refused over Reality,
which the core cannot serve there; a type changed to one that binds nothing, or
that nothing is served over TLS for, drops what it can no longer have. A type
this panel does not know is left to the core. The listen options every binding
type shares beyond its address and port — a detour, TCP and UDP options,
keep-alive — are switched on in the reference's groups from a menu at the foot
of that block, and are edited inside the document by name: nothing else in it
is touched. What the reference adds beyond that is left out: each type's own
options, its users, the rest of what a client is handed and the subscribers to
give a new listener, which the API takes one subscriber at a time.

The route out's dialog is the reference's too, without its second tab; the
dialog and its blocks are written once in `src/components` for every dialog laid
out this way. It has the type and the tag, then where a type that sends to a
server sends, then a block for the type's own options and the reference's dial
block. The reference gives each type's options a block of
fields, and TLS, transport and multiplexing a block each; the panel has the one
block, holding the options document typed out, for the reason a listener carries
its document through. The server's address and port and the dial options every
type that dials shares are fields over keys of that same document, the dial
options switched on in the reference's groups from a menu at the foot of their
block, and a document that cannot be read holds them still until it is put
right. Another type starts afresh, as the reference starts it, keeping only where
it sends to and how it dials as far as the new type does either. The types are
the reference's, with a block route besides, which the reference leaves out and
the core still takes. It is offered beside direct, and has nothing past its type
and its tag, which the dialog says under them; it is sent as those two alone, so
options left on one by something other than the panel are let go rather than
sent back to be refused. As it refuses whatever is dialled through it, the dial
block leaves it out of the routes it offers to dial through, which also keeps a
detour switched on from starting at one. A route can be a WireGuard tunnel as
well, offered after trojan, where the reference offered one while the core still
took it as an outbound, with the options of the endpoint the core takes it as
now, which the API writes it into: its server's address and port are its one
peer's, the far end of the tunnel, and the peer starts out allowing every
address, as a route out sends whatever is routed to it. Its block has the
reference's WireGuard fields over keys of the same document -- the private key,
the peer's public key and the key the two share, the local addresses, those the
peer is sent and the MTU -- with the API generating a key pair, as the reference
has it, and working out the public half of a private key there already is; the
public half goes to whoever runs the far end and the core has nowhere to keep
it, so it is shown only as it is asked for. The reference's second tab, which
reads a share link into the fields as the route out to that server, is left out:
a route is written from its fields alone. The dial options are written once in
`src/lib/dial.ts` for every dialog with a dial block.

Two consequences of the backend's design show up in the front end:

- **The session is a cookie, not a token**, so there is nothing to read on
  startup to find out whether anyone is signed in — the answer is a request.
  `AuthProvider` therefore has three states rather than two: signed in, signed
  out, and not yet known. Routes wait on the third, which is what stops a
  reload from bouncing an operator to the sign-in page before the answer
  arrives.
- **Writes are same-origin checked**, which the dev server has to respect.
  Vite proxies `/api` to the Go server with `changeOrigin` off, so the
  browser's `Origin` and the request's `Host` still agree. Turning it on — the
  usual default — rewrites the `Host` to the target and makes every write from
  the dev server look cross-site.

Tests split along the same seam as the backend's. Vitest and Testing Library
cover what the unit tests can reach without a browser: the byte and date
conversions between what is stored and what is typed, the schemas, the table
rendering, the route table. Playwright covers what only a browser can — being
turned away from a protected page, signing in, switching maintenance on —
against `page.route` mocks rather than a running server, so the end-to-end
suite needs neither a database nor a node.

## Links

A configuration tells a node what to serve. A **link** tells a subscriber how to
reach it — `vless://…`, `ss://…`, `vmess://…` — and is what a client application
imports.

Generation is pure: `service.GenerateLinks` reads a client and an inbound and
returns strings. It needs no core, no node and no database, which is why the
whole of it is covered by tests that touch none of those.

Three things shape the output:

- **The subscriber's identities.** A client's `config` holds one entry per
  protocol — a uuid for vless, a password for trojan — and only the entry
  matching the inbound's type is used.
- **The inbound's published addresses.** An inbound listens once but can be
  published many times: a CDN edge and an origin, a domain and a bare address.
  Each publication produces its own link and can override the TLS the inbound
  advertises. With none configured, the host the request arrived on is used.
- **The TLS pair.** A listener's TLS is stored as two halves because they are
  not the same document: the server half — its `tls` option — holds certificates
  and keys, the client half — `out_json.tls` — holds what a subscriber needs to
  trust them. Only the fields that describe the handshake cross over, which is
  what keeps a private key out of a link — there is a test that asserts exactly
  that. A client half with no server half beside it is no TLS at all.

Links are built through `url.URL` rather than by formatting a string and parsing
it back. That is not tidiness: a password containing a space, a `#`, a `%` or a
non-ASCII character makes the string form unparseable, and one such subscriber
would otherwise break link generation for everyone on the panel.

They are computed on read rather than stored, so an edit to an inbound is
reflected the next time a subscription is fetched.

## Identities and the cascade

A subscriber's `config` holds one identity per protocol — a uuid for vless, a
password for trojan, a username and password for socks. They are **minted by the
panel, never asked for**: an operator who has to supply a uuid by hand for every
protocol will eventually reuse one, and a reused credential is two subscribers
sharing a quota.

Three rules govern them:

- **Generated once.** An existing credential is never regenerated. A
  subscriber's uuid is in every client application they have installed, and
  rewriting it during an unrelated edit cuts them off with nothing to explain
  why. Only an absent or empty value is filled.
- **Display names follow a rename, credentials do not.** `name` and `username`
  track the client's own name; the secret beside them does not move.
- **Unused identities are kept.** Moving a subscriber off vmess does not delete
  their vmess identity. Deleting it and later re-adding the inbound would mint
  new credentials and break every client that still had the old ones.

The identity shape matters as much as its value: a `name` field is added only
where that protocol carries one, because a key the core does not expect in a
user entry is a key it refuses. So does the form of a credential: a shadowsocks
key is the standard base64 of 32 bytes, or of 16 for a method that reads a
128-bit one, since a 2022 method refuses any other and one from before takes it
all the same. Snell has an identity with a key of its own, since sing-box 1.14
gave it a user per subscriber, and so does a shadowtls listener from version 3.

Identities are minted wherever a subscriber comes to need one: in the client's
own edit, and in an inbound's — one given subscribers as it is created, or one
changed to a type or a method that asks for a different identity. Only what is
missing is minted, and only the identities are written back, so an inbound's edit
cannot put back a subscriber's traffic counters.

### The cascade

A client's inbound references live inside a jsonb array, so there is no foreign
key to keep them honest. `InboundService.Delete` therefore removes the inbound
from every client that named it, in the same transaction as the delete:

```sql
UPDATE clients
SET inbounds = COALESCE(
    (SELECT jsonb_agg(entry) FROM jsonb_array_elements(inbounds) AS entry
     WHERE entry <> to_jsonb(?::bigint)), '[]'::jsonb)
WHERE inbounds @> to_jsonb(?::bigint)
```

One statement rather than a read-edit-write per client: deleting an inbound on a
panel with thousands of subscribers would otherwise be thousands of round trips
inside one transaction. Without the cascade at all, the deleted id stays in every
list that named it, nothing reports an error, and the subscription silently comes
back one node short.

The same mechanism runs the other way: creating an inbound with `?initClients=`
assigns it to those subscribers as it is created, because the alternative —
create, then edit every subscriber — is what operators actually do, one request
at a time.

## Subscriptions

A subscription is how a subscriber gets their links without anyone sending them
by hand. It is served on a **second listener**, with its own port, certificate,
host check and proxy list.

The separation is the point. The panel should be reachable by a handful of
people; the subscription endpoint has to be reachable by everyone who was sold
one. They share a process — one binary, two `http.Server`s — but nothing else:
no session, no token, no shared middleware chain.

Three formats, because client applications support one or two of them and not
the others:

| `?format=` | Body |
|---|---|
| *(default)* | One URI per line, base64-encoded when `subEncode` is on |
| `json` | A sing-box client configuration |
| `clash` | Clash/Mihomo YAML |

All three are built from one enumeration of the subscriber's nodes, not three.
Rendering each format independently is how a node ends up in one subscription
and quietly missing from another. A format that cannot express a protocol leaves
its node out rather than emitting it half-formed: snell has no link, and neither
it nor naive has a Clash proxy worth emitting, but both are sing-box outbounds —
naive over QUIC with the listener's congestion control when it asks for one, and
snell in the listener's version with the subscriber's own key.

An outbound's TLS says more than a link's, as the reference's does: besides the
server name and protocols, the versions, the cipher suites and the handshake's
timeout cross over from the server half, so both ends agree on them, along with
the certificate when the client pins nothing else to trust it by, and Reality
and ECH switched on to match. The key still never crosses.

Four response headers carry what a client shows in its own interface:
`Subscription-Userinfo` (quota spent and expiry — the current period, not the
lifetime total), `Profile-Update-Interval`, `Profile-Title`, and a
`Content-Disposition` in both the plain and RFC 5987 spellings so a title in any
script survives. `HEAD` returns the headers alone, which is how a client
refreshes the displayed quota without refetching everything.

There is no authentication. The subscription id **is** the credential, which
has two consequences: it must be unguessable, and every failure has to look
identical. An unknown id, a disabled subscriber and a database error all answer
with the same empty 404 — anything else would let an anonymous caller map which
ids exist.

### Timestamps

Every time is unix seconds in a `bigint`, not `timestamptz`. It is the less
obvious choice for Postgres, and it is deliberate: these values are compared,
added to and served as JSON numbers, never formatted or grouped by the
database. A column type that carries a zone would add a conversion at each end
and a class of bug — the same instant read back in a different zone — in
exchange for nothing this schema uses.

### References

A listener's TLS is part of the listener, not a reference to a configuration
kept apart, so there is nothing for the service to check on a write and nothing
a delete could leave a listener pointing at.

`tokens.user_id` is a genuine foreign key with `ON DELETE CASCADE`: a token
carries its owner's authority, so it must not outlive the owner.

### Reserved words

`clients` stores `description` and `group_name`, because `desc` and `group` are
reserved in Postgres. The Go fields keep the names the domain uses and map
across with `gorm:"column:..."`, so the JSON an API client sees is unchanged.

### Traffic

Samples are stored per bucket, and `(resource, tag, date_time, direction)` is
unique. Ingest upserts with `stats.traffic + excluded.traffic`, so a node
reporting every ten seconds into a sixty-second bucket produces one row per
bucket rather than six. The retention purge deletes in bounded chunks: one
unbounded `DELETE` over a month of samples holds its locks long enough to make
the cleanup itself a cause of lost accounting.

Traffic reports are **deltas, not running totals**. A node that restarts and
counts from zero again would otherwise subtract its own history from every
subscriber it serves. Counters are incremented in SQL (`up + ?`) rather than
read-modify-written, so two nodes reporting for the same subscriber at the same
moment both count.

## Authentication

Two schemes, the same endpoints behind each.

**Session cookie** (`{base}api`) — for a browser. The cookie is `HttpOnly`,
`SameSite=Strict`, and `Secure` when the request arrived over TLS. Whether it
did is derived per request: a hardcoded `true` breaks signing in on every HTTP-only
install, and a hardcoded `false` gives up the protection on HTTPS ones. Behind
a proxy the forwarded scheme is the only evidence, and it is believed only from
a loopback or private peer — otherwise anyone who can reach an HTTP-only panel
could set the header and lock the operator out of their own panel.

**Token header** (`{base}apiv2`) — for scripts and nodes. Tokens are held in
memory and refreshed explicitly rather than looked up per request: this is on
the path of every call, and a database round trip per call turns a token into a
way to load the database from outside. Comparison is constant-time.

The cookie API additionally enforces same-origin on state-changing methods. The
token API does not need it: a cross-site page cannot set a `Token` header
without a CORS preflight that is never answered.

### Defences on the sign-in path

- bcrypt, with a dummy comparison on the no-such-user path so an unknown
  username costs the same as a known one. Without it the two differ by a whole
  bcrypt round and usernames are enumerable by timing.
- Per-address lockout after repeated failures. Counted per address and never
  per username — counting per username would let anyone lock an operator out
  of their own panel by guessing at their name from somewhere else.
- One message for every failure, whatever actually went wrong.
- No default credentials. There is no "reset to admin/admin": the first account
  is created from `X_UI_ROOT_USERNAME` / `X_UI_ROOT_PASSWORD`
  or from the CLI, and if neither happens the panel starts with no account and
  says so. A panel that bootstraps itself with a password from the README is
  reachable by anyone who read it, during exactly the window when nobody is
  watching. `cli seed` is held to the same rule and invents nothing: with no
  credentials to seed from it fails rather than picking something.

### Two-factor authentication

An operator can have sign-in ask for a second factor: the six-digit code an
authenticator app shows (TOTP, RFC 6238 — SHA-1, 30-second steps, one step of
clock drift either way, which is what every app supports). The secret is 20
random bytes, stored in `users.totp_secret` and never returned by the API — the
account's `twoFactor` says only whether it is on.

- The code is asked for only after the password is right. Sent without one, the
  sign-in is refused with `obj.twoFactor` set and the panel asks for it; that is
  the one answer that differs from the others, and only someone holding the
  password gets it. A wrong code is counted by the same per-address lockout as a
  wrong password.
- A code is accepted once. The last step each account used is remembered, so a
  code read over a shoulder or out of a proxy's log is refused for the minute it
  would otherwise stay good.
- Setting it up stores nothing until a code from the app is typed back against
  the secret, so a setup abandoned half way locks nobody out; turning it off
  takes a code as well, so a session left open on an unattended screen is not
  enough to take the second factor away.
- An operator who lost their authenticator is let back in with
  `x-ui-cli admin -disable-two-factor <username>`, which needs access to
  the host rather than to the panel — the same line `admin` draws for
  passwords.

## Configuration

Two sources, later winning: `configs/config.yaml`, then `X_UI_*`
environment variables. One configuration, with no environment selecting between
several.

That is deliberate. An environment name is a claim that a deployment is one of
three known shapes, and it stops being true the first time there are two
production deployments, or a staging one, or a developer who needs the
production database read-only. What actually differs between one place the
panel runs and another is a handful of values — an address, a password, a
session secret — and those are what the environment already carries. The rest
was the same everywhere and only looked configurable.

The defaults in `config.Default()` are a complete configuration on their own, so
a container can run on environment variables with no file at all, and the file
overrides the keys it names rather than blanking the rest.

Secrets come from the environment, or on a host the installer set up, from a
`config.yaml` only root can read (see Installation). `Validate()` refuses
`ssl_mode: disable` against a remote database — checked by the host rather than
by an environment name, so it holds wherever the panel is running. An empty
session secret is generated at startup and warned about loudly rather than
refused: with nothing declaring which deployment is the serious one, refusing
it would only stop the developer it never mattered for.

What is left of the old environment split is one switch: `log.level: debug`
turns on SQL logging and gin's debug mode. An operator who turns the log up is
asking what the process is doing, which is the same question.

Anything the process needs in order to start lives here. The `settings` table
holds only what an operator changes while it is running and expects to survive
a restart, which is the set that cannot come from a file the operator may have
no way to edit. The panel's settings page shows the rest as the process read it
(`GET /settings/startup`) and never writes it; nothing secret is in that view —
the session secret is said to be set or not, and the database is left out.

The editable Panel form uses `GET/POST /settings/panel` and saves only its
listener, session lifetime, worker and logging options. Saving never restarts
the processes. `POST /settings/panel/restart` accepts the saved file revision
and returns a task ID with HTTP 202; `GET /settings/panel/restart/:id` reports
its progress. The installed CLI runs the task under a separate systemd timer
and service, so replacing the API does not terminate its own restart task.
Task records, the applied configuration checkpoint and API/worker readiness
files live in the root-private `configs/.panel-runtime` directory. Configuration
saves and restart tasks share a cross-process file lock. Readiness checks
compare the supervisor's PID, the process startup time and effective settings,
and probe `/healthz` at the root independently of the panel's Web path.
Only the API, worker and, for connection changes, the locally managed agent
are restarted. Connection refresh preserves the existing token, statistics and
core settings. Failure restores only Panel keys and backed-up agent connection
files, preserving unrelated YAML options. A helper interrupted mid-operation
resumes recovery rather than retrying the failing configuration.
Legacy loopback agents are supported even without an installer state file.
Their authenticated Panel connection is checked through `node -check-panel`,
without requiring or initializing native statistics and core settings.

The Overview's local core card uses `GET /core` to read `sing-box.service`
through systemd, independently of the maintenance flag. `POST /core/restart`
accepts only `{}` and queues an independent CLI task with HTTP 202. Concurrent
requests return the current task. `GET /core/restart/:id` follows its persisted
progress; `GET /core/logs` returns at most 80 journal entries (64 KiB).
These routes use the same session/token authentication as other operator tools.

The core task records its actor, timestamps, before/after PIDs and terminal
result under root-private `configs/.core-runtime`, and audits its request and
result. It validates the installed service's actual configuration arguments,
preserving its data and configuration directories. Only the installed local
`sing-box.service` is restarted. Validation failure leaves the process running;
success requires a different PID and a healthy authenticated loopback native
statistics API. The readiness probe reads a cumulative snapshot without
advancing the agent's traffic measurements. An interrupted helper does not
issue a second restart when resuming verification.

The installed agent reload helper and core task both hold
`<core-config-directory>/.x-ui-core.lock` while validating, applying or
restarting. This prevents a manual restart from racing a downloaded core
configuration. The capability is unavailable for unsupported service launch
arguments, unmanaged agents or missing native statistics. Panel configuration,
API/worker processes, agent credentials and remote nodes are not changed by
the core restart task.

That line is why the address subscribers fetch from is `subscription.public_url`
in the file rather than a row in the table. It belongs beside the port, path,
domain and certificate that describe the same listener; a copy in the table
would be a second answer to a question the file already answers, and the two
would disagree the first time either was edited. Left empty it is assembled from
those neighbours plus the host the request arrived on, and `/subscription-uri`
serves the result — which is what the panel shows as a subscriber's own link.

## Processes

**`cmd/api`** serves the HTTP API and the built panel. Stateless apart from
the sign-in rate limiter and the token table, both of which are per-process and
deliberately so: a failed sign-in should not be a database write an attacker
can drive. The record of which two-factor code each account last used is
per-process too, so behind several API instances a code accepted by one could
be accepted once more by another within its minute.

**`cmd/worker`** runs what no request triggers — taking depleted subscribers
offline, rolling periodic quotas over, purging traffic past its retention
window, revoking expired tokens. It is separate from the API so a panel under
load, or mid-restart, does not stop enforcing quotas, and so a deployment can
run one worker alongside several API instances. Jobs are wrapped in `Recover`
and `SkipIfStillRunning`: they contend for the same rows, and overlapping runs
would each wait on the other's locks to do the same work twice. The subscribers
a pass takes offline are named in one Telegram notification, when the bot is
set up to send it.

**`cmd/cli`** is what an operator reaches for when the panel is what is broken,
and what a deploy script runs before it is up: `migrate` then `seed`. Every
subcommand works against the database directly and none needs the API.

**`cmd/agent`** is the only one that does not run on the panel's host. See
below.

## The node agent

x-ui does not carry traffic and does not embed a proxy core. A node runs
the core, and beside it runs the agent, which is the only thing that talks to
the panel.

Two loops, on separate intervals, because they fail differently:

- **Configuration sync** pulls `GET /apiv2/config/download`, hashes it, and only
  when the hash changed writes it and runs the operator's reload command. A
  reload drops connections, so polling every thirty seconds must not mean
  dropping them every thirty seconds. A failure here is survivable: the node
  keeps serving what it already had.
- **Traffic reporting** reads the core's counters and pushes deltas to
  `POST /apiv2/traffic`. A failure here is not survivable in the same way —
  reading the counters is destructive, so a dropped batch is traffic the core
  has forgotten and the panel never saw. Failed batches are held and sent with
  the next one.

The configuration is written through a temporary file and renamed. A core
reading a half-written document refuses to start, and rename is atomic within a
filesystem, so it sees either the old file or the new one — never half of
either. The file is `0600`: it carries every subscriber's credentials.

The reload command is run **directly, never through a shell**. It comes from a
configuration file, and a shell would turn any value in it into something that
can be made to mean more than it says.

### Reading the counters

`StatsSource` is an interface with one implementation, because how a core
exposes its counters is the part most likely to differ between cores and
versions.

The shipped one polls a sing-box Clash API. That API reports each *live*
connection's cumulative totals, which is not what the panel wants, so the
adapter converts:

- a connection seen before contributes the difference since last time;
- a connection seen for the first time contributes its whole total;
- a connection that has gone contributes nothing further — what it moved was
  counted while it was open;
- a counter that went *backwards* means the core restarted and reissued the id,
  so the new total is taken rather than a negative, which would hand a
  subscriber back quota they had already spent.

**Known limitation.** A connection that opens and closes entirely between two
polls is never observed, and its traffic is lost. The ten-second default report
interval is chosen for that, not for freshness. A core exposing resettable
per-user counters — sing-box's V2Ray stats service does — would not have this
gap, and is the natural second implementation of `StatsSource`.

### Migrations

The schema starts from one migration, `001_init`, which sets an empty database
up whole: the eight tables, their indexes, and the `direct` and `block` routes
out. A change to the schema after it is a numbered pair of its own, never an
edit to `001_init` — a database that has run the initialization does not run it
again, so an edit there would reach fresh installs and nothing else.

Both long-running processes migrate on startup, and both take a Postgres
advisory lock first — so a deploy that starts them together is safe, and
neither needs a separate migration step in the pipeline. Each migration runs in
its own transaction; Postgres makes DDL transactional, so a file that fails
halfway leaves nothing behind and its version is not recorded.

Versions are compared numerically, not lexically. `010` must sort after `002`,
and sorting file names as strings puts it between `001` and `002` — which
applies a later migration before an earlier one.

## Installation

`install.sh` is the reference's installer carried over: run as root on a fresh
host, it leaves the panel running under systemd — or OpenRC on Alpine — and run
again, it upgrades in place. What it installs is a release built by
`scripts/package.sh`: an archive per Linux platform holding the three binaries
the panel's host runs, the migrations, the built panel, and the menu and the
systemd units that go with them, published with a `SHA256SUMS` the installer
will not go on without. The agent is not in it; it belongs on a node, and a
node is set up by hand.

What changed on the way over follows from what x-ui is:

- **A database to set up.** The reference's SQLite is a file beside its binary.
  Here the installer finds a PostgreSQL — the one `X_UI_DATABASE_URL`
  names, or else one on the same host, installed from the distribution when
  there is none — and gives the panel a role and a database of its own, with a
  generated password. It changes nothing else about a server it did not set
  up, with one exception: where the distribution answers loopback with ident
  (the RHEL family, openSUSE), two lines at the top of `pg_hba.conf` let that
  one role sign in with its password. A cluster it does set up is told not to
  trust connections from the host, which Arch's and Alpine's would otherwise
  do.
- **Settings in config.yaml, not the settings table.** Ports and paths are
  startup configuration here (see Configuration), so what the installer asks is
  written into `/usr/local/x-ui/configs/config.yaml`, the file the panel
  reads its configuration from anyway — one place to look rather than two. The
  services find it below the directory they start in, and the `x-ui-cli`
  the installer puts on the PATH is pointed at it, so the three never disagree
  about which database they mean. The database password and a session secret
  generated once are kept there too, the file readable by root alone; an
  upgrade keeps it, and so signs nobody out. The installer changes the keys it
  looks after in place and nothing else, so whatever an operator adds to the
  file stays.
- **No panel path.** The panel is built for the root, `/`, and loads its scripts
  from there, so the installer asks for the two ports and the subscription path
  and not for the panel's.
- **No default credentials** (see Authentication), and still an account at the
  end. A fresh install that is not given one gets random credentials, made up
  by the installer and printed once. `seed` still invents nothing: it is handed
  them through its environment, so they never appear on a command line.
- **Nothing else on the host is upgraded.** The reference updates every package
  first; this refreshes the indexes and installs what it needs — apart from
  Arch, where installing anything without a full upgrade is unsupported.
- **An upgrade that fails leaves the running version running.** The new files
  are copied in beside the old ones and the new binary is tried before anything
  is stopped. A checksum that is missing stops the install like one that is
  wrong: every release here has one, where the reference's earliest had none.
- **Two units, shipped in the release.** The reference's archive carries
  `s-ui.service`; this one carries `x-ui-api.service` and
  `x-ui-worker.service`, so a unit always describes the binaries beside
  it, whichever version the installer came from. They keep the reference's
  hardening — no new privileges, a private `/tmp`, home directories read-only —
  except that the worker, which serves no certificate, has `/root` and `/home`
  hidden altogether. `LimitNOFILE` is not carried over: the reference raises it
  for the two descriptors a proxy holds per connection, and neither process
  here carries a connection through. The OpenRC scripts are still written by
  the installer, as the reference writes its own.

### The menu

`x-ui.sh` is the reference's `s-ui.sh`, installed as
`/usr/bin/x-ui`. Run as root, it is a menu for installing, updating and
removing the panel, its operator account and settings, its two services and
their logs; given a command — `start`, `stop`, `restart`,
`status`, `enable`, `disable`, `log`, `update`, `install`, `uninstall` — it does
that alone. It keeps the reference's numbering where it could, and changes what
does not fit a panel that carries no traffic and keeps its data in PostgreSQL:

- **No reset to default credentials.** Its place goes to turning an account's
  two-factor authentication off, the other way an operator ends up locked out
  (see Authentication).
- **Settings are config.yaml's.** The ports and the subscription path are
  written where the installer writes them, with the installer's checks, and the
  services are restarted to take them. Resetting restores the settings the panel
  keeps in its database, through `x-ui-cli setting -reset`; the ports are
  configuration, and stay as they are.
- **Certificates are configured, not issued, by x-ui.** The panel and
  subscription listener can each serve an externally managed certificate by
  setting `cert_file` and `key_file` in config.yaml. The API reads them at
  startup, so the external renewal process must restart the API after replacing
  the files. Existing paths under `/root/cert` or `/root/cert-CF` still work.
  `x-ui-cli healthcheck`, which the installer waits on, asks as the
  panel's domain and takes whatever certificate it is served: it dials an
  address no certificate is issued for.
- **No self-signed certificate and no BBR.** The reference makes the one for the
  core it embeds and switches the other for the traffic it carries, and a
  panel's host has neither. The panel mints a self-signed certificate itself
  (see Operator tooling).
- **The database stays.** The reference's uninstall takes the data with its
  directory. Here the data is PostgreSQL's: the uninstall leaves it, says how
  to drop it, and installing again picks it up.
- **The installer is downloaded before it runs.** Piped into bash, a download
  cut off halfway runs the half that arrived, and one that fails outright runs
  nothing and reports success. The menu the installer then replaces is renamed
  into place rather than rewritten, because `x-ui update` is still
  reading the old one.
- **Ctrl-C ends a log, not the menu.**

## Operator tooling

Four things an operator reaches for around the panel rather than inside it.

**Key material** (`GET /api/keypairs?kind=`) mints Reality and WireGuard X25519
pairs, a self-signed certificate, and an OpenVPN static key. It exists because
the alternative to generating a private key here is generating it on a web page
somebody else runs, which is the one place a private key should never be made.
Nothing is stored: it is generated, returned once, and forgotten — with
`Cache-Control: no-store`, because a caching proxy holding a private key is the
same problem one step removed.

ECH keys are not generated. They need the core's own implementation, and
producing something that merely looks like one would be worse than saying so.

**Certificate probe** (`POST /api/cert-probe`) dials a host and describes what
it presents: subject, issuer, SANs, expiry, fingerprint, whether it is
self-signed, and what the handshake negotiated. Verification is deliberately
skipped — refusing to look at a certificate because it does not verify is
exactly backwards for a diagnostic — and nothing here trusts the result.

**System status** (`GET /api/system`) reports the process, the host and the row
counts. Every section is optional: a reading that cannot be taken is *omitted*
rather than reported as zero, because zero disk usage and unknown disk usage
look identical on a dashboard and mean opposite things. What failed is named in
`warnings`.

**Backup and restore** (`GET /api/backup`, `POST /api/backup/restore`, and
`x-ui-cli backup`) is a *logical* export — a JSON document of every
table — not a file copy. `pg_dump` remains the right tool for an operational
backup; this is the one the panel can offer through its own API, and the one
that restores into a fresh install of a different version. A restore runs in a
single transaction, so a file that turns out to be unreadable halfway through
leaves the existing data untouched rather than half-replaced, and a table the
export does not carry is left alone rather than emptied. Listeners are exported
in the panel's own shape rather than the core's, so where each is published and
what its clients are handed — the client half of its TLS among it — come back
with it; a restored listener is numbered afresh, as it always has been.

Two consequences worth knowing: an export contains every credential the panel
holds, so taking one is recorded in the audit log; and a restore replaces the
operator accounts too, so whoever ran it will be signing in with the backup's
credentials, not their own. The response says so.

## Notifications

The panel can tell operators what happened through a Telegram bot: an operator
signing in, with the address they signed in from, and the subscribers the
worker takes offline for running out of quota or time. Each is switched on its
own, and the bot as a whole (`tgBotEnable`, `tgNotifySignIn`,
`tgNotifyDeplete`); the token is the one @BotFather hands out, and the chats
are ids, negative for a group.

The bot only sends. Each message is one `sendMessage` request to the Bot API,
made when the event happens, so there is no process of its own, nothing held
open and no polling for commands — a panel with the bot off does no work for it
at all, and the host needs only to reach `api.telegram.org` over HTTPS.

- A notification never fails what sent it: a sign-in answers before the message
  goes out, and a Telegram that is down costs a line in the log, not a sign-in
  or a pass of the worker. Every chat is tried whatever the ones before it
  said.
- The token is part of the address a message is posted to, so an error from the
  transport — which names the address — is never passed on as it came: it
  would put the token in the log, or in front of whoever pressed the button.
- The bot is not switched on without a token and at least one chat: it would
  look set up and never send a thing. *Send a test message*
  (`POST /telegram/test`) sends with the bot as it is saved, switched on or
  not, and answers with what Telegram said of a message it refused.

## Testing

`go test ./...` needs no database: it covers the quota and expiry state
machine, configuration loading and precedence, the migration loader, password
handling and validation, the two-factor codes against RFC 6238's own test
vectors, and the Telegram notifier against a stand-in for the Bot API — nothing
in the suite reaches Telegram. Fixtures live in `test/data/`.

That is the whole suite, and the compose file brings up one database rather than
two. What real SQL would exercise — upsert accumulation, the chunked purge,
transaction rollback — is not covered, and is worth knowing when changing a
repository: the layering above it is tested, the queries themselves are not.
Adding that back means a database the suite may truncate, which is not the one
being developed against.

## Relationship to the reference implementation

The structure and the operational behaviour are modelled on the s-ui backend.
What is carried over: the layered shape, the response envelope, the settings
table with defaults and protected keys, the audit log, the quota and delayed-
start state machine, the sign-in defences, and the reasoning behind the cookie
attributes and the same-origin check. The panel's layout is carried over from the
s-ui frontend in the same way — the rail, the app bar, the sign-in card, the
overview's tiles, the inbound and outbound cards, the
listener (its TLS block with the reference's TLS dialog in it), subscriber, route
out, rule, DNS and credentials dialogs, the clients table and the rules,
DNS, admins and settings pages keep its measurements and its behaviour — and
is built from the design system rather than from Vuetify.

Three of the reference's tiles are not offered here, because the API does not
answer with what they draw: disk I/O counters, the host's own addresses, and the
traffic every subscriber has used added up. They are left out rather than drawn
empty — a dial reading zero and a dial reading nothing look identical and mean
opposite things — and the counts dialog says how much of everything there is
without saying how much has moved.

Nor are the live connections the reference lists when a listener's online chip is
pressed, or its button that cuts off every connection a subscriber has open. The
API holds no connections, only the traffic nodes report, so on a card the badge
says the listener has moved traffic lately and leads nowhere; a subscriber is
cut off by being disabled, which takes them out of the users at the next sync.

What is different, and why:

- **PostgreSQL instead of SQLite.** The SQLite-specific machinery — WAL
  checkpointing, busy timeouts, immediate transactions, file permissions on the
  database and its sidecars — is gone, replaced by a connection pool and
  advisory locks. Upserts use `ON CONFLICT`; `jsonb` replaces JSON-in-text.
- **Repositories split out of services**, so rules are testable without a
  database and queries are not duplicated.
- **Configuration files instead of a settings table** for everything needed at
  startup.
- **SQL migrations instead of `AutoMigrate`**: an initialization that sets the
  schema up, then up and down files for each change after it, with a recorded
  version.
- **RESTful routes** instead of one dispatch endpoint with an `action`
  parameter, and real status codes instead of `200` with `success: false`.
- **Traffic is reported over the API** rather than drained from an embedded
  proxy core. Embedding the core is the bulk of the reference implementation
  and is not part of this one — which is what makes the API and the data plane
  independently deployable.
- **The panel is built separately** and served from a directory, rather than
  compiled into the binary. It is the same trade as the core: a server that
  does not need the front end's toolchain to build, and a front end that can be
  rebuilt without relinking the server.
