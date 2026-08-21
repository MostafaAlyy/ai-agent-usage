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
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const SNAPSHOT_PATH = GLib.build_filenamev([GLib.get_user_state_dir(), 'agent-usage', 'usage.json']);
const COLLECTOR_PATH = GLib.build_filenamev([GLib.get_user_data_dir(), 'agent-usage', 'agent-usage']);

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

function formatResetStamp(iso) {
    if (!iso)
        return '';
    const when = GLib.DateTime.new_from_iso8601(iso, null);
    if (!when)
        return '';
    return when.to_local().format('%a %H:%M') ?? '';
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
        this._footer = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._body);
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

        this._watchSnapshot();
        this._loadSnapshot();
        this._scheduleRefresh();
        /* Data may be from before suspend or from a login that predates the
         * collector's first timer run, so ask for a refresh once at start. */
        this._runCollector(false);
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

    /* The collector runs as its own process. Nothing here waits on it -- the
     * file monitor above is what turns a finished run into a redraw. */
    _runCollector(force) {
        if (this._refreshing)
            return;
        if (!GLib.file_test(COLLECTOR_PATH, GLib.FileTest.IS_EXECUTABLE)) {
            log_(`collector not found at ${COLLECTOR_PATH}`);
            this._render();
            return;
        }

        const argv = [COLLECTOR_PATH];
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
            this._runCollector(true);
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
        this._updatedLabel.text = `Last updated: ${formatClock(this._snapshot?.updatedAt)}`;
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

        const providers = this._enabledProviders();
        if (!this._snapshot) {
            this._body.addMenuItem(this._noticeItem(
                this._refreshing ? 'Loading usage…' : 'No usage data yet.',
                this._refreshing ? '' : 'Press Refresh to run the collector for the first time.'));
        } else if (providers.length === 0) {
            this._body.addMenuItem(this._noticeItem('No providers enabled.', 'Enable one in the extension preferences.'));
        } else {
            providers.forEach((provider, index) => {
                if (index > 0)
                    this._body.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
                this._addProvider(provider);
            });
        }

        this._updatePanel();
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
        titleRow.add_child(new St.Label({
            text: provider.name ?? provider.id,
            style_class: 'aiu-provider',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const badge = provider.plan || STATUS_TEXT[provider.status] || '';
        if (badge)
            titleRow.add_child(new St.Label({text: badge, style_class: 'aiu-badge', y_align: Clutter.ActorAlign.CENTER}));
        card.add_child(titleRow);

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
            // Without a plan the badge is already carrying the status text.
            const text = STATUS_TEXT[provider.status] ?? 'No usage reported';
            card.add_child(new St.Label({text, style_class: 'aiu-dim aiu-empty'}));
        }

        if (provider.stale)
            card.add_child(new St.Label({text: 'Showing the last known figures.', style_class: 'aiu-dim aiu-note'}));

        if (provider.message) {
            const note = new St.Label({text: provider.message, style_class: 'aiu-dim aiu-note aiu-wrap'});
            note.clutter_text.line_wrap = true;
            card.add_child(note);
        }

        item.add_child(card);
        this._body.addMenuItem(item);
    }

    _limitRow(entry) {
        const percent = Math.max(0, Number(entry.percent) || 0);
        const severity = this._severity(percent);
        const row = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'aiu-limit'});

        const head = new St.BoxLayout({x_expand: true, style_class: 'aiu-limit-header'});
        const label = new St.Label({text: entry.label ?? 'Limit', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        label.clutter_text.ellipsize = 3; /* Pango.EllipsizeMode.END */
        head.add_child(label);
        head.add_child(new St.Label({
            text: `${Math.round(percent)}%`,
            style_class: `aiu-value${severity ? ` aiu-${severity}` : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        row.add_child(head);
        row.add_child(new UsageBar(percent / 100, severity));

        if (entry.resetsAt && this._settings.get_boolean('show-countdown')) {
            const reset = new St.Label({style_class: 'aiu-dim aiu-reset'});
            reset.text = `${formatCountdown(entry.resetsAt)} · ${formatResetStamp(entry.resetsAt)}`;
            this._countdownLabels.push({label: reset, resetsAt: entry.resetsAt});
            row.add_child(reset);
        }
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
            const window = String(worst.label ?? '').toLowerCase().includes('week') ? 'weekly' : 'session';
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
            label.text = `${formatCountdown(resetsAt)} · ${formatResetStamp(resetsAt)}`;
    }

    _onDestroy() {
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
