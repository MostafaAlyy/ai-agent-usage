// SPDX-FileCopyrightText: 2026 Mostafa Aly
// SPDX-License-Identifier: MIT OR GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PROVIDERS = [
    {id: 'antigravity', title: 'Google Antigravity', subtitle: 'Read from local Antigravity IDE / agy language server'},
    {id: 'codex', title: 'OpenAI Codex', subtitle: 'Read from the local codex CLI'},
    {id: 'claude', title: 'Claude Code', subtitle: 'Read from the Claude Code sign-in'},
];

/* The providers live in one string list, so each switch adds or removes its
 * own id rather than rewriting the whole list. */
function bindProviderSwitch(settings, row, id) {
    const toggle = new Gtk.Switch({active: settings.get_strv('enabled-providers').includes(id), valign: Gtk.Align.CENTER});
    row.add_suffix(toggle);
    row.activatable_widget = toggle;
    toggle.connect('notify::active', () => {
        const current = new Set(settings.get_strv('enabled-providers'));
        if (toggle.active)
            current.add(id);
        else
            current.delete(id);
        settings.set_strv('enabled-providers', PROVIDERS.map(p => p.id).filter(p => current.has(p)));
    });
}

/* A shortcut row that captures the next key combination.
 *
 * GTK has no ready-made accelerator picker, so the row shows the current
 * binding as a Gtk.ShortcutLabel and swaps to a modal capture window when
 * activated. Escape cancels, Backspace clears -- the conventions people
 * already expect from GNOME's own keyboard settings. */
function addShortcutRow(settings, group, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const label = new Gtk.ShortcutLabel({
        valign: Gtk.Align.CENTER,
        disabled_text: 'Disabled',
        accelerator: settings.get_strv(key)[0] ?? '',
    });
    row.add_suffix(label);
    settings.connect(`changed::${key}`, () => {
        label.accelerator = settings.get_strv(key)[0] ?? '';
    });

    row.connect('activated', () => {
        const capture = new Adw.Window({
            modal: true,
            transient_for: row.get_root(),
            hide_on_close: true,
            width_request: 380,
            height_request: 180,
            content: new Adw.StatusPage({
                title: 'Press a shortcut',
                description: 'Esc to cancel, Backspace to disable',
                icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            }),
        });

        const keys = new Gtk.EventControllerKey();
        capture.add_controller(keys);
        keys.connect('key-pressed', (_controller, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            if (keyval === Gdk.KEY_Escape && mask === 0) {
                capture.close();
                return true;   // handled
            }
            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                settings.set_strv(key, []);
                capture.close();
                return true;   // handled
            }
            // A bare modifier is the user still reaching for the combination.
            if (!Gtk.accelerator_valid(keyval, mask))
                return true;   // handled
            settings.set_strv(key, [Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask)]);
            capture.close();
            return true;   // handled
        });

        capture.present();
    });

    group.add(row);
    return row;
}

export default class AiAgentUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const providers = new Adw.PreferencesGroup({
            title: 'Providers',
            description: 'A provider that is switched off is never queried and never shown.',
        });
        page.add(providers);
        for (const provider of PROVIDERS) {
            const row = new Adw.ActionRow({title: provider.title, subtitle: provider.subtitle});
            bindProviderSwitch(settings, row, provider.id);
            providers.add(row);
        }

        const behaviour = new Adw.PreferencesGroup({title: 'Refresh'});
        page.add(behaviour);

        const interval = new Adw.SpinRow({
            title: 'Refresh interval',
            subtitle: 'Minutes between automatic refreshes',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 240, step_increment: 1, page_increment: 5}),
        });
        behaviour.add(interval);
        settings.bind('refresh-interval', interval, 'value', Gio.SettingsBindFlags.DEFAULT);

        const shortcuts = new Adw.PreferencesGroup({title: 'Shortcut'});
        page.add(shortcuts);
        addShortcutRow(settings, shortcuts, 'ai-agent-usage-toggle', 'Open the usage popup',
            'Works from anywhere, including the overview');

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);

        const percentage = new Adw.SwitchRow({
            title: 'Show percentage in the panel',
            subtitle: 'Displays the highest usage across enabled providers',
        });
        appearance.add(percentage);
        settings.bind('show-percentage', percentage, 'active', Gio.SettingsBindFlags.DEFAULT);

        const countdown = new Adw.SwitchRow({title: 'Show reset countdown'});
        appearance.add(countdown);
        settings.bind('show-countdown', countdown, 'active', Gio.SettingsBindFlags.DEFAULT);

        const scoped = new Adw.SwitchRow({
            title: 'Show model-scoped limits',
            subtitle: 'Per-model allowances alongside the account-wide windows',
        });
        appearance.add(scoped);
        settings.bind('show-scoped-limits', scoped, 'active', Gio.SettingsBindFlags.DEFAULT);

        const threshold = new Adw.SpinRow({
            title: 'Warning threshold',
            subtitle: 'Highlight usage at or above this percentage',
            adjustment: new Gtk.Adjustment({lower: 50, upper: 100, step_increment: 5, page_increment: 10}),
        });
        appearance.add(threshold);
        settings.bind('warning-threshold', threshold, 'value', Gio.SettingsBindFlags.DEFAULT);
    }
}
