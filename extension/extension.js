// SPDX-FileCopyrightText: 2026 Mostafa Aly
// SPDX-License-Identifier: MIT OR GPL-2.0-or-later

/* AI Agent Usage -- GNOME Shell panel indicator.
 *
 * The Shell never talks to a provider. It reads one cached JSON snapshot
 * written by the `agent-usage` collector, watches that file for changes, and
 * asks the collector to refresh on a timer or on demand. Every call out of
 * this file is asynchronous, so a slow network can never stall the compositor.
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SNAPSHOT_PATH = GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-usage', 'usage.json']);

/* A refresh triggered by opening the menu reuses a snapshot this fresh
 * rather than spawning the collector for a glance. */
const OPEN_REFRESH_MAX_AGE_SECONDS = 300;
/* The countdown labels only need to move once a minute, and only while the
 * menu is actually on screen. */
const COUNTDOWN_TICK_SECONDS = 30;
const CRITICAL_PERCENT = 95;

const STATUS_TEXT = {
    not_configured: 'Not configured',
    auth: 'Sign-in needed',
    error: 'Unavailable',
};

/* Status dot colour per provider state, shown in the controls list. */
const STATUS_DOT = {
    ok: 'aiu-dot-ok',
    not_configured: 'aiu-dot-off',
    auth: 'aiu-dot-warn',
    error: 'aiu-dot-error',
};

/* Providers known to this version of the extension, in display order. The
 * snapshot is the source of truth for data, but a provider the collector has
 * never reported (fresh install, first run still pending) still needs a
 * control row so it can be switched off without opening Preferences. */
const KNOWN_PROVIDERS = [
    {id: 'antigravity', name: 'Google Antigravity'},
    {id: 'codex', name: 'Codex'},
    {id: 'claude', name: 'Claude Code'},
    {id: 'opencode-go', name: 'OpenCode Go'},
];

/* The schema default grew an entry in this version. A user who never touched
 * the setting gets the new default automatically; a user whose stored value
 * is exactly the previous default gets the new provider appended once. */
const PROVIDERS_DEFAULT_OLD = ['antigravity', 'codex', 'claude'];
const PROVIDERS_DEFAULT_NEW = [...PROVIDERS_DEFAULT_OLD, 'opencode-go'];

function log_(message) {
    console.log(`[ai-agent-usage] ${message}`);
}

function formatClock(iso) {
    if (!iso)
        return '--:--';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '--:--';
    const local = when.to_local();
    const text = local.format('%H:%M');
    return text ?? '--:--';
}

/* "Resets in 5h 14m" -- the shape people actually read a limit window in. */
function formatCountdown(iso) {
    if (!iso)
        return '';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '';
    const seconds = when.difference(GLib.DateTime.new_now_utc()) / 1000000;
    if (seconds <= 0)
        return 'Resetting';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0)
        return `Resets in ${days}d ${hours}h`;
    if (hours > 0)
        return `Resets in ${hours}h ${minutes}m`;
    return `Resets in ${Math.max(minutes, 1)}m`;
}

function formatCountdownShort(iso) {
    if (!iso)
        return '';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '';
    const seconds = when.difference(GLib.DateTime.new_now_utc()) / 1000000;
    if (seconds <= 0)
        return 'now';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0)
        return `in ${days}d ${hours}h`;
    if (hours > 0)
        return `in ${hours}h ${minutes}m`;
    return `in ${Math.max(minutes, 1)}m`;
}

function formatResetStamp(iso) {
    if (!iso)
        return '';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '';
    return when.to_local().format('%a %H:%M') ?? '';
}

function formatRelativeUpdated(iso) {
    if (!iso)
        return 'never';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '--:--';
    const diffSeconds = Math.max(0, GLib.DateTime.new_now_utc().difference(when.to_utc()) / 1000000);
    if (diffSeconds < 60)
        return 'just now';
    const mins = Math.floor(diffSeconds / 60);
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return formatClock(iso);
}

/* A percentage bar.
 *
 * The fill is placed in vfunc_allocate rather than by reacting to
 * notify::width and calling set_width. Resizing a child from inside a size
 * notification re-enters the allocation cycle, which Clutter reports once per
 * actor per refresh ("needs an allocation") and which costs a second layout
 * pass for every bar on screen. Allocating the fill directly is both exact --
 * it uses the track's content box, so theme padding and font scaling are
 * already accounted for -- and free of that feedback loop.
 */
const UsageBar = GObject.registerClass(
class UsageBar extends St.Widget {
    _init(fraction, severity) {
        super._init({style_class: 'aiu-bar-track', x_expand: true});
        this._fraction = Math.max(0, Math.min(1, fraction));
        this._fill = new St.Widget({style_class: `aiu-bar-fill${severity ? ` aiu-${severity}` : ''}`});
        this.add_child(this._fill);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const content = this.get_theme_node().get_content_box(box);
        const width = content.get_width();
        /* A non-zero percentage always draws something: a 1% bar that renders
         * as nothing reads as "no data" rather than "barely used". */
        const filled = this._fraction <= 0 ? 0 : Math.max(3, Math.round(width * this._fraction));
        this._fill.allocate(new Clutter.ActorBox({
            x1: content.x1,
            y1: content.y1,
            x2: content.x1 + Math.min(filled, width),
            y2: content.y2,
        }));
    }
});

const AgentUsageIndicator = GObject.registerClass(
class AgentUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'AI Agent Usage');
        this._extension = extension;
        this._settings = extension.getSettings();
        this._snapshot = null;
        this._countdownLabels = [];
        this._refreshing = false;
        this._timeoutId = 0;
        this._countdownId = 0;
        this._tooltip = null;
        this._tooltipId = 0;
        /* Card collapse state is session-only: it is a glance preference, not
         * a setting worth syncing. */
        this._collapsed = new Set();
        this._updatedLabels = [];

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box aiu-panel-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${extension.path}/icons/ai-agent-symbolic.svg`),
            style_class: 'system-status-icon',
        });
        this._panelLabel = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'aiu-panel-label',
            visible: false,
        });
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);

        this._header = new PopupMenu.PopupMenuSection();
        this._body = new PopupMenu.PopupMenuSection();
        this._controls = new PopupMenu.PopupMenuSection();
        this._footer = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._body);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._controls);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._footer);
        this._buildChrome();
        this._renderedAt = null;

        this._settingsIds = [
            'enabled-providers', 'show-countdown', 'show-scoped-limits', 'warning-threshold',
        ].map(key => this._settings.connect(`changed::${key}`, () => this._render({force: true})));
        // Panel-only settings never touch the cards, so they must not pay for
        // a rebuild of them.
        this._settingsIds.push(this._settings.connect('changed::show-percentage', () => this._updatePanel()));
        this._settingsIds.push(this._settings.connect('changed::refresh-interval', () => this._scheduleRefresh()));

        this.menu.connect('open-state-changed', (_menu, isOpen) => this._onOpenStateChanged(isOpen));
        this.connect('notify::hover', () => this._onHover());
        this.connect('destroy', () => this._onDestroy());

        /* Startup is where an extension most often takes itself out: anything
         * that throws in the constructor leaves the Shell with no indicator at
         * all and only a backtrace in the journal. Each step is independent,
         * so one failing must cost only its own feature -- a broken keybinding
         * should still leave a readable panel. */
        this._guard('keybinding', () => this._addKeybinding());
        this._guard('D-Bus interface', () => this._exportDBus());
        this._guard('file monitor', () => this._watchSnapshot());
        this._guard('initial read', () => this._loadSnapshot());
        this._guard('provider defaults', () => this._migrateProviderDefaults());
        this._guard('refresh timer', () => this._scheduleRefresh());
        /* Data may be from before suspend or from a login that predates the
         * collector's first timer run, so ask for a refresh once at start. */
        this._guard('initial refresh', () => this._runCollector(false));
        this._guard('first paint', () => this._render({force: true}));
    }

    _migrateProviderDefaults() {
        let current;
        try {
            current = this._settings.get_strv('enabled-providers');
        } catch {
            return;
        }
        if (current.length === PROVIDERS_DEFAULT_OLD.length &&
            PROVIDERS_DEFAULT_OLD.every(id => current.includes(id))) {
            this._settings.set_strv('enabled-providers', PROVIDERS_DEFAULT_NEW);
            log_('enabled-providers migrated to include opencode-go');
        }
    }

    /* Run one startup step, and turn a failure into a logged note rather than
     * a dead extension. The message surfaces in the popup so the panel says
     * what is wrong instead of silently missing a feature. */
    _guard(what, step) {
        try {
            step();
        } catch (error) {
            log_(`${what} failed: ${error}`);
            this._startupErrors ??= [];
            this._startupErrors.push(what);
        }
    }

    /* A shortcut is the fast path this widget is for: glance at the numbers
     * without hunting for the icon. Opening the menu runs the same stale
     * check a click does, so the figures are current by the time they are
     * read. */
    /* A D-Bus entry point, so the popup can also be opened by a command.
     *
     * Extension keybindings never appear in Settings' Custom Shortcuts list,
     * and mutter can refuse a keybinding name outright. A method on the
     * session bus gives a second, independent route in: bind any command you
     * like to `gdbus call ... Toggle` and it works regardless. */
    _exportDBus() {
        const iface = `<node><interface name="org.gnome.Shell.Extensions.AiAgentUsage">
            <method name="Toggle"/><method name="Open"/><method name="Refresh"/>
        </interface></node>`;
        this._dbus = Gio.DBusExportedObject.wrapJSObject(iface, {
            Toggle: () => this.menu.toggle(),
            Open: () => this.menu.open(),
            Refresh: () => this._runCollector(true),
        });
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/AiAgentUsage');
    }

    _addKeybinding() {
        /* addKeybinding returns Meta.KeyBindingAction.NONE on failure rather
         * than throwing, so a shortcut that never registers -- taken by
         * another grab, or an accelerator the active layout cannot produce --
         * would otherwise fail in complete silence. */
        const action = Main.wm.addKeybinding(
            'ai-agent-usage-toggle',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.menu.toggle());

        const accelerator = this._settings.get_strv('ai-agent-usage-toggle')[0] ?? '';
        if (action === Meta.KeyBindingAction.NONE) {
            log_(`could not register the shortcut ${accelerator || '(unset)'};`
                + ' it may already be taken by another application');
            throw new Error(`shortcut ${accelerator} was refused`);
        }
        log_(`shortcut registered: ${accelerator || '(unset)'}`);
        this._keybindingAdded = true;
    }

    /* ------------------------------------------------------------- data */

    _watchSnapshot() {
        const file = Gio.File.new_for_path(SNAPSHOT_PATH);
        try {
            this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', (_m, _f, _o, type) => {
                if (type === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                    type === Gio.FileMonitorEvent.CREATED ||
                    type === Gio.FileMonitorEvent.MOVED_IN ||
                    type === Gio.FileMonitorEvent.RENAMED)
                    this._loadSnapshot();
            });
        } catch (error) {
            log_(`could not watch the snapshot: ${error.message}`);
        }
    }

    _loadSnapshot() {
        const file = Gio.File.new_for_path(SNAPSHOT_PATH);
        file.load_contents_async(null, (source, result) => {
            let parsed = null;
            try {
                const [ok, bytes] = source.load_contents_finish(result);
                if (ok)
                    parsed = JSON.parse(new TextDecoder().decode(bytes));
            } catch (error) {
                if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                    log_(`could not read the snapshot: ${error.message}`);
            }
            this._snapshot = parsed;
            this._render();
        });
    }

    /* The collector ships inside the extension and runs as its own gjs
     * process, so the Shell never does the gathering itself. */
    _collectorPath() {
        return GLib.build_filenamev([this._extension.path, 'collector.js']);
    }

    _collectorInstalled() {
        return GLib.file_test(this._collectorPath(), GLib.FileTest.IS_REGULAR);
    }

    /* The collector runs as its own process. Nothing here waits on it -- the
     * file monitor above is what turns a finished run into a redraw. */
    _runCollector(force) {
        if (this._refreshing)
            return;
        if (!this._collectorInstalled()) {
            log_(`collector.js is missing from ${this._extension.path}`);
            this._render({force: true});
            return;
        }

        const argv = ['gjs', '-m', this._collectorPath()];
        if (force)
            argv.push('--force');
        else
            argv.push('--max-age', String(OPEN_REFRESH_MAX_AGE_SECONDS));

        let proc;
        try {
            proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            log_(`could not start the collector: ${error.message}`);
            return;
        }

        this._refreshing = true;
        this._render();
        proc.communicate_utf8_async(null, null, (source, result) => {
            this._refreshing = false;
            try {
                const [, , stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful())
                    log_(`collector exited with an error: ${(stderr ?? '').trim().split('\n').pop()}`);
            } catch (error) {
                log_(`collector failed: ${error.message}`);
            }
            this._render();
        });
    }

    _scheduleRefresh() {
        if (this._timeoutId)
            GLib.Source.remove(this._timeoutId);
        const minutes = Math.max(1, this._settings.get_int('refresh-interval'));
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, minutes * 60, () => {
            try {
                this._runCollector(true);
            } catch (error) {
                // Returning without SOURCE_CONTINUE would end every future
                // refresh over one bad run.
                log_(`scheduled refresh failed: ${error}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* --------------------------------------------------------- rendering */

    _enabledProviders() {
        const wanted = this._settings.get_strv('enabled-providers');
        const providers = this._snapshot?.providers ?? {};
        return Object.keys(providers)
            .filter(id => wanted.includes(id))
            .map(id => providers[id]);
    }

    /* Every provider the menu knows about: the snapshot's data first, then a
     * placeholder for any enabled id the collector has never reported, so its
     * switch is still reachable. Unknown ids from the snapshot (a newer
     * collector than this UI) are appended rather than dropped. */
    _allKnownProviders() {
        const wanted = this._settings.get_strv('enabled-providers');
        const providers = this._snapshot?.providers ?? {};
        const seen = new Set();
        const out = [];
        for (const {id, name} of KNOWN_PROVIDERS) {
            seen.add(id);
            out.push(providers[id] ?? {id, name, status: 'error', limits: [], message: '', updatedAt: null});
        }
        for (const id of Object.keys(providers)) {
            if (!seen.has(id)) {
                seen.add(id);
                out.push(providers[id]);
            }
        }
        for (const id of wanted) {
            if (!seen.has(id)) {
                seen.add(id);
                out.push({id, name: id, status: 'error', limits: [], message: '', updatedAt: null});
            }
        }
        return out;
    }

    _isProviderEnabled(id) {
        return this._settings.get_strv('enabled-providers').includes(id);
    }

    /* One switch adds or removes its own id, same contract as Preferences. */
    _setProviderEnabled(id, enabled) {
        const order = this._allKnownProviders().map(entry => entry.id);
        const current = new Set(this._settings.get_strv('enabled-providers'));
        if (enabled)
            current.add(id);
        else
            current.delete(id);
        this._settings.set_strv('enabled-providers', order.filter(entry => current.has(entry)));
    }

    _visibleLimits(provider) {
        const limits = provider.limits ?? [];
        if (this._settings.get_boolean('show-scoped-limits'))
            return limits;
        return limits.filter(entry => entry.group !== 'scoped');
    }

    _severity(percent) {
        if (percent >= CRITICAL_PERCENT)
            return 'critical';
        if (percent >= this._settings.get_int('warning-threshold'))
            return 'warning';
        return '';
    }

    /* Header and footer are built once. Only their text changes, so a
     * refresh that lands while the menu is open never re-adds actors to a
     * mapped popup -- which is both cheaper and quieter in the journal. */
    _buildChrome() {
        const headerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
        const headerBox = new St.BoxLayout({x_expand: true, style_class: 'aiu-header'});
        headerBox.add_child(new St.Label({text: 'AI Agents', style_class: 'aiu-title', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._busyLabel = new St.Label({text: 'Refreshing…', style_class: 'aiu-dim', y_align: Clutter.ActorAlign.CENTER, visible: false});
        headerBox.add_child(this._busyLabel);
        headerItem.add_child(headerBox);
        this._header.addMenuItem(headerItem);

        const footerItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
        const row = new St.BoxLayout({x_expand: true, style_class: 'aiu-footer'});
        this._updatedLabel = new St.Label({
            style_class: 'aiu-dim',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        row.add_child(this._updatedLabel);

        this._refreshButton = new St.Button({
            style_class: 'aiu-button',
            can_focus: true,
            child: new St.BoxLayout({style_class: 'aiu-button-box'}),
        });
        this._refreshButton.child.add_child(new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'aiu-button-icon'}));
        this._refreshButton.child.add_child(new St.Label({text: 'Refresh', y_align: Clutter.ActorAlign.CENTER}));
        this._refreshButton.connect('clicked', () => this._runCollector(true));
        row.add_child(this._refreshButton);

        const prefs = new St.Button({
            style_class: 'aiu-button aiu-icon-button',
            can_focus: true,
            child: new St.Icon({icon_name: 'emblem-system-symbolic', style_class: 'aiu-button-icon'}),
        });
        prefs.connect('clicked', () => {
            this.menu.close();
            this._extension.openPreferences();
        });
        row.add_child(prefs);

        footerItem.add_child(row);
        this._footer.addMenuItem(footerItem);
    }

    _updateChrome() {
        this._busyLabel.visible = this._refreshing;
        this._refreshButton.reactive = !this._refreshing;
        this._updatedLabel.text = `Updated ${formatRelativeUpdated(this._snapshot?.updatedAt)}`;
    }

    _render({force = false} = {}) {
        this._updateChrome();

        /* Rebuilding provider cards is the expensive part; skip it unless the
         * data behind them actually moved. */
        const stamp = this._snapshot?.updatedAt ?? null;
        if (!force && stamp !== null && stamp === this._renderedAt) {
            this._updatePanel();
            return;
        }
        this._renderedAt = stamp;

        this._body.removeAll();
        this._countdownLabels = [];
        this._updatedLabels = [];

        const providers = this._enabledProviders();
        if (!this._snapshot && !this._collectorInstalled()) {
            this._body.addMenuItem(this._noticeItem(
                'Collector missing',
                'collector.js was not found in the extension directory. '
                + 'Reinstalling the extension should restore it.'));
        } else if (!this._snapshot) {
            this._body.addMenuItem(this._noticeItem(
                this._refreshing ? 'Loading usage…' : 'No usage data yet.',
                this._refreshing ? '' : 'Press Refresh to run the collector for the first time.'));
        } else if (providers.length === 0) {
            this._body.addMenuItem(this._noticeItem('No providers enabled.', 'Enable one in the extension preferences.'));
        } else {
            providers.forEach(provider => {
                this._addProvider(provider);
            });
        }

        if (this._startupErrors?.length) {
            this._body.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            this._body.addMenuItem(this._noticeItem(
                'Some features did not start',
                `${this._startupErrors.join(', ')}. See: journalctl --user -b /usr/bin/gnome-shell`));
        }

        this._renderControls();
        this._updatePanel();
    }

    /* The quick controllers: one row per provider with a status dot and an
     * on/off switch, so enabling Claude or disabling anything else never
     * needs a trip to Preferences. Rebuilt with the cards because the set of
     * known providers only changes when the data does. */
    _renderControls() {
        this._controls.removeAll();

        const titleItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
        titleItem.add_child(new St.Label({text: 'Providers', style_class: 'aiu-section-title', x_expand: true}));
        this._controls.addMenuItem(titleItem);

        for (const provider of this._allKnownProviders()) {
            const id = provider.id;
            const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
            const row = new St.BoxLayout({x_expand: true, style_class: 'aiu-control-row'});

            const dotClass = provider.stale ? 'aiu-dot-stale' : (STATUS_DOT[provider.status] ?? 'aiu-dot-error');
            row.add_child(new St.Widget({style_class: `aiu-dot ${dotClass}`, y_align: Clutter.ActorAlign.CENTER}));
            const name = new St.Label({
                text: provider.name ?? id,
                style_class: 'aiu-control-name',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            name.clutter_text.ellipsize = 3; /* Pango.EllipsizeMode.END */
            row.add_child(name);

            const hint = provider.stale ? 'Cached'
                : (provider.status && provider.status !== 'ok' ? (STATUS_TEXT[provider.status] ?? provider.status) : '');
            if (hint) {
                row.add_child(new St.Label({
                    text: hint,
                    style_class: 'aiu-dim aiu-control-hint',
                    y_align: Clutter.ActorAlign.CENTER,
                }));
            }

            const toggle = new St.Button({
                style_class: 'aiu-switch aiu-switch-on',
                can_focus: true,
                toggle_mode: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Widget({style_class: 'aiu-switch-knob'}),
            });
            toggle.set_checked(this._isProviderEnabled(id));
            this._syncSwitchStyle(toggle);
            toggle.connect('clicked', () => {
                /* With toggle_mode the button has already flipped by the
                 * time clicked fires; the settings listener re-renders. */
                this._setProviderEnabled(id, toggle.checked);
            });
            toggle.accessible_name = `Show ${provider.name ?? id} in the menu`;
            row.add_child(toggle);

            item.add_child(row);
            this._controls.addMenuItem(item);
        }
    }

    _syncSwitchStyle(toggle) {
        toggle.remove_style_class_name(toggle.checked ? 'aiu-switch-off' : 'aiu-switch-on');
        toggle.add_style_class_name(toggle.checked ? 'aiu-switch-on' : 'aiu-switch-off');
        toggle.get_child()?.set_x_align(toggle.checked ? Clutter.ActorAlign.END : Clutter.ActorAlign.START);
    }

    _noticeItem(title, subtitle) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        box.add_child(new St.Label({text: title, style_class: 'aiu-notice'}));
        if (subtitle) {
            const hint = new St.Label({text: subtitle, style_class: 'aiu-dim aiu-wrap'});
            hint.clutter_text.line_wrap = true;
            box.add_child(hint);
        }
        item.add_child(box);
        return item;
    }

    _addProvider(provider) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false, style_class: 'aiu-item'});
        const card = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'aiu-card'});

        const titleRow = new St.BoxLayout({x_expand: true, style_class: 'aiu-card-header'});

        // Provider icon with fallback to general AI agent icon
        const iconPath = `${this._extension.path}/icons/${provider.id}-symbolic.svg`;
        const hasIcon = GLib.file_test(iconPath, GLib.FileTest.EXISTS);
        const iconFile = hasIcon ? iconPath : `${this._extension.path}/icons/ai-agent-symbolic.svg`;
        titleRow.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(iconFile),
            style_class: `aiu-provider-icon aiu-icon-${provider.id}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        titleRow.add_child(new St.Label({
            text: provider.name ?? provider.id,
            style_class: 'aiu-provider',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));

        /* "3m ago" per card: with four providers on different timers, one
         * global timestamp no longer says which figure is fresh. */
        if (provider.updatedAt) {
            const updated = new St.Label({
                text: formatRelativeUpdated(provider.updatedAt),
                style_class: 'aiu-dim aiu-updated',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._updatedLabels.push({label: updated, iso: provider.updatedAt});
            titleRow.add_child(updated);
        }

        // Semantic Badges: Plan, Stale/Cached, or Status
        if (provider.plan) {
            titleRow.add_child(new St.Label({
                text: provider.plan,
                style_class: 'aiu-badge aiu-badge-plan',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        if (provider.stale) {
            titleRow.add_child(new St.Label({
                text: 'Cached',
                style_class: 'aiu-badge aiu-badge-stale',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        } else if (provider.status && provider.status !== 'ok') {
            const statusClass = provider.status === 'auth' ? 'aiu-badge-warning' : 'aiu-badge-error';
            titleRow.add_child(new St.Label({
                text: STATUS_TEXT[provider.status] ?? provider.status,
                style_class: `aiu-badge ${statusClass}`,
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }

        card.add_child(titleRow);

        /* Cards collapse to their header: an open/close controller per
         * provider for long menus. The choice is session-only. */
        const collapsed = this._collapsed.has(provider.id);
        const expander = new St.Button({
            style_class: 'aiu-button aiu-icon-button aiu-expander',
            can_focus: true,
            child: new St.Icon({
                icon_name: collapsed ? 'pan-end-symbolic' : 'pan-down-symbolic',
                style_class: 'aiu-button-icon',
            }),
            y_align: Clutter.ActorAlign.CENTER,
        });
        expander.accessible_name = collapsed
            ? `Expand ${provider.name ?? provider.id}`
            : `Collapse ${provider.name ?? provider.id}`;
        expander.connect('clicked', () => {
            if (this._collapsed.has(provider.id))
                this._collapsed.delete(provider.id);
            else
                this._collapsed.add(provider.id);
            this._render({force: true});
        });
        titleRow.add_child(expander);

        if (collapsed)
            card.add_child(new St.Label({text: this._collapsedSummary(provider), style_class: 'aiu-dim aiu-collapsed-summary'}));
        else {
            const limits = this._visibleLimits(provider);
            for (const entry of limits)
                card.add_child(this._limitRow(entry));

            if (provider.balance?.text) {
                const row = new St.BoxLayout({x_expand: true, style_class: 'aiu-limit-header'});
                row.add_child(new St.Label({text: provider.balance.label ?? 'Balance', x_expand: true}));
                row.add_child(new St.Label({text: provider.balance.text, style_class: 'aiu-value'}));
                card.add_child(row);
            }

            if (limits.length === 0 && !provider.balance && provider.plan) {
                const text = STATUS_TEXT[provider.status] ?? 'No usage reported';
                card.add_child(new St.Label({text, style_class: 'aiu-dim aiu-empty'}));
            }

            if (provider.message && !provider.stale && limits.length === 0) {
                const note = new St.Label({text: provider.message, style_class: 'aiu-dim aiu-note aiu-wrap'});
                note.clutter_text.line_wrap = true;
                card.add_child(note);
            }
        }

        item.add_child(card);
        this._body.addMenuItem(item);
    }

    /* One-line headline for a collapsed card: the worst window, same number
     * the panel shows. */
    _collapsedSummary(provider) {
        const limits = this._headlineLimits(provider);
        if (!limits.length)
            return STATUS_TEXT[provider.status] ?? 'No data';
        const worst = limits.reduce((a, b) => (Number(b.percent) > Number(a.percent) ? b : a));
        return `${worst.label ?? 'Limit'} · ${Math.round(Number(worst.percent))}%`;
    }

    _limitRow(entry) {
        const percent = Math.max(0, Number(entry.percent) || 0);
        const severity = this._severity(percent);
        const row = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'aiu-limit'});

        const head = new St.BoxLayout({x_expand: true, style_class: 'aiu-limit-header'});
        const label = new St.Label({
            text: entry.label ?? 'Limit',
            style_class: 'aiu-limit-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        label.clutter_text.ellipsize = 3; /* Pango.EllipsizeMode.END */
        head.add_child(label);

        if (entry.resetsAt && this._settings.get_boolean('show-countdown')) {
            const countdown = new St.Label({
                text: formatCountdownShort(entry.resetsAt),
                style_class: 'aiu-dim aiu-countdown-inline',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._countdownLabels.push({label: countdown, resetsAt: entry.resetsAt});
            head.add_child(countdown);
        }

        head.add_child(new St.Label({
            text: `${Math.round(percent)}%`,
            style_class: `aiu-value${severity ? ` aiu-${severity}` : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(head);
        row.add_child(new UsageBar(percent / 100, severity));

        return row;
    }

    /* ------------------------------------------------------ panel + hover */

    /* The panel speaks for the account, not for one model. A model-scoped
     * allowance at 100% is worth colouring inside the menu, but it does not
     * mean the account is out -- so it must not paint the top bar red for the
     * rest of the week. Account-wide windows win; scoped ones are the
     * fallback only for a provider that reports nothing else. */
    _headlineLimits(provider) {
        const limits = this._visibleLimits(provider);
        const primary = limits.filter(entry => entry.group !== 'scoped');
        return primary.length > 0 ? primary : limits;
    }

    _headlinePercent() {
        let highest = null;
        for (const provider of this._enabledProviders()) {
            for (const entry of this._headlineLimits(provider)) {
                const value = Number(entry.percent);
                if (Number.isFinite(value) && (highest === null || value > highest))
                    highest = value;
            }
        }
        return highest;
    }

    _updatePanel() {
        const highest = this._headlinePercent();
        const show = this._settings.get_boolean('show-percentage') && highest !== null;
        this._panelLabel.visible = show;
        if (show)
            this._panelLabel.text = `${Math.round(highest)}%`;

        const severity = highest === null ? '' : this._severity(highest);
        for (const name of ['aiu-warning', 'aiu-critical'])
            this._icon.remove_style_class_name(name);
        if (severity)
            this._icon.add_style_class_name(`aiu-${severity}`);

        this._tooltipText = this._buildTooltip();
        this.accessible_name = this._tooltipText || 'AI Agent Usage';
        if (this._tooltip)
            this._tooltip.text = this._tooltipText;
    }

    /* "Codex 87% weekly • Claude 81% weekly" -- the headline number per
     * provider, which is whichever of its windows is closest to its limit. */
    _buildTooltip() {
        const parts = [];
        for (const provider of this._enabledProviders()) {
            const limits = this._headlineLimits(provider);
            if (limits.length === 0) {
                parts.push(`${provider.name}: ${STATUS_TEXT[provider.status] ?? 'no data'}`);
                continue;
            }
            const worst = limits.reduce((a, b) => (Number(b.percent) > Number(a.percent) ? b : a));
            const label = String(worst.label ?? '').toLowerCase();
            const window = label.includes('week') ? 'weekly' : (label.includes('5-hour') || label.includes('5h')) ? '5h' : 'session';
            parts.push(`${provider.name} ${Math.round(Number(worst.percent))}% ${window}`);
        }
        return parts.join(' • ');
    }

    _onHover() {
        if (this._tooltipId) {
            GLib.Source.remove(this._tooltipId);
            this._tooltipId = 0;
        }
        if (!this.hover || this.menu.isOpen || !this._tooltipText) {
            this._hideTooltip();
            return;
        }
        this._tooltipId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
            this._tooltipId = 0;
            this._showTooltip();
            return GLib.SOURCE_REMOVE;
        });
    }

    _showTooltip() {
        if (!this.hover || this.menu.isOpen)
            return;
        if (!this._tooltip) {
            this._tooltip = new St.Label({style_class: 'aiu-tooltip'});
            Main.layoutManager.addTopChrome(this._tooltip);
        }
        this._tooltip.text = this._tooltipText;
        this._tooltip.opacity = 255;
        this._tooltip.show();

        const [x, y] = this.get_transformed_position();
        const monitor = Main.layoutManager.primaryMonitor;
        const width = this._tooltip.get_width();
        const left = Math.max(monitor.x + 4, Math.min(x + this.get_width() / 2 - width / 2, monitor.x + monitor.width - width - 4));
        this._tooltip.set_position(Math.round(left), Math.round(y + this.get_height() + 4));
    }

    _hideTooltip() {
        this._tooltip?.hide();
    }

    _onOpenStateChanged(isOpen) {
        if (isOpen) {
            this._hideTooltip();
            /* Only spawn the collector if what we have is actually old. */
            this._runCollector(false);
            this._tickCountdowns();
            this._countdownId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, COUNTDOWN_TICK_SECONDS, () => {
                this._tickCountdowns();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (this._countdownId) {
            GLib.Source.remove(this._countdownId);
            this._countdownId = 0;
        }
    }

    _tickCountdowns() {
        for (const {label, resetsAt} of this._countdownLabels)
            label.text = formatCountdownShort(resetsAt);
        for (const {label, iso} of this._updatedLabels)
            label.text = formatRelativeUpdated(iso);
        this._updateChrome();
    }

    _onDestroy() {
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        if (this._keybindingAdded) {
            Main.wm.removeKeybinding('ai-agent-usage-toggle');
            this._keybindingAdded = false;
        }
        for (const id of [this._timeoutId, this._countdownId, this._tooltipId]) {
            if (id)
                GLib.Source.remove(id);
        }
        this._timeoutId = this._countdownId = this._tooltipId = 0;
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const id of this._settingsIds ?? [])
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._tooltip?.destroy();
        this._tooltip = null;
    }
});

export default class AiAgentUsageExtension extends Extension {
    enable() {
        this._indicator = new AgentUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
