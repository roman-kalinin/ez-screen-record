using System.Text.Json;
using EzScreenRecord.Models;
using Microsoft.Win32;

namespace EzScreenRecord.Interop;

/// <summary>
/// "Do Not Disturb while recording": suppress Windows toast notifications for
/// the duration of a take and restore the user's prior setting afterwards.
///
/// The mechanism is a single per-user registry DWORD that WpnUserService reads
/// live, so no admin rights are needed and the change takes effect for new
/// toasts at once (it does not dismiss a banner already on screen).
///
/// Nothing here throws into a recording path: DND is a nicety, not a
/// requirement, so every registry touch is wrapped and failures are swallowed.
///
/// Crash safety: before mutating anything we persist <c>{ modified, prior }</c>
/// to a small state file next to settings.json. <see cref="RestoreOnLaunch"/>
/// reads it at startup and, if a prior run left DND on (it crashed mid-take),
/// restores the captured value and clears the flag.
/// </summary>
internal static class DoNotDisturb
{
    private const string KeyPath =
        @"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings";
    private const string ValueName = "NOC_GLOBAL_SETTING_TOASTS_ENABLED";

    private static string StatePath =>
        Path.Combine(AppSettings.SettingsDirectory, "dnd-state.json");

    /// <summary>Persisted crash-safety snapshot.</summary>
    private sealed class DndState
    {
        public bool Modified { get; set; }

        /// <summary>
        /// The DWORD value before we suppressed (0 or 1), or null when the value
        /// was absent — in which case restore means DELETE it (the true default).
        /// </summary>
        public int? Prior { get; set; }
    }

    // --- Registry primitives ------------------------------------------------

    /// <summary>Current toast setting: 0/1, or null when the value is absent.</summary>
    public static int? GetPrior()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(KeyPath);
            return key?.GetValue(ValueName) as int?;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Suppress all toasts (set the DWORD to 0).</summary>
    public static void Suppress()
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            key.SetValue(ValueName, 0, RegistryValueKind.DWord);
        }
        catch { /* best effort — never block recording */ }
    }

    /// <summary>Restore a captured value; null deletes the value (default-on).</summary>
    public static void Restore(int? prior)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(KeyPath);
            if (prior is null) key.DeleteValue(ValueName, throwOnMissingValue: false);
            else key.SetValue(ValueName, prior.Value, RegistryValueKind.DWord);
        }
        catch { /* best effort */ }
    }

    // --- Crash-safe state file ---------------------------------------------

    private static void WriteState(DndState state)
    {
        try
        {
            Directory.CreateDirectory(AppSettings.SettingsDirectory);
            File.WriteAllText(StatePath, JsonSerializer.Serialize(state));
        }
        catch { /* best effort */ }
    }

    private static DndState? ReadState()
    {
        try
        {
            if (!File.Exists(StatePath)) return null;
            return JsonSerializer.Deserialize<DndState>(File.ReadAllText(StatePath));
        }
        catch
        {
            return null;
        }
    }

    private static void ClearState()
    {
        try { if (File.Exists(StatePath)) File.Delete(StatePath); }
        catch { /* best effort */ }
    }

    // --- Public API ---------------------------------------------------------

    /// <summary>
    /// Called at the real start of a take (the caller guards on the setting).
    /// Captures the prior value, persists the crash flag BEFORE mutating, then
    /// suppresses notifications. A second enable without an intervening restore
    /// is a no-op so the original captured value is never overwritten.
    /// </summary>
    public static void Enable()
    {
        try
        {
            if (ReadState() is { Modified: true }) return;

            var prior = GetPrior();
            WriteState(new DndState { Modified = true, Prior = prior });
            Suppress();
        }
        catch { /* best effort */ }
    }

    /// <summary>
    /// Called when the take stops. Restores the captured value and clears the
    /// crash flag. No-op unless a prior <see cref="Enable"/> actually changed
    /// anything, so it is safe to call from every teardown path.
    /// </summary>
    public static void Disable()
    {
        try
        {
            if (ReadState() is not { Modified: true } state) return;
            Restore(state.Prior);
            ClearState();
        }
        catch { /* best effort */ }
    }

    /// <summary>
    /// Startup recovery: if a prior run left DND modified (it crashed mid-take),
    /// restore the captured value and clear the flag. Safe no-op otherwise.
    /// </summary>
    public static void RestoreOnLaunch()
    {
        try
        {
            if (ReadState() is not { Modified: true } state) return;
            Restore(state.Prior);
            ClearState();
        }
        catch { /* best effort */ }
    }
}
