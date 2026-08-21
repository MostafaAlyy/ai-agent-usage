import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const PROVIDERS = [
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
