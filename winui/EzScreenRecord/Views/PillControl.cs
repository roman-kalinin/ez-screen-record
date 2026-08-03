using Microsoft.UI;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Media;
using Windows.UI;

namespace EzScreenRecord.Views;

/// <summary>
/// Google Meet style split control: a chevron that opens a device menu, joined
/// to a toggle that turns the thing on or off.
///
/// Ported from components/PillControl.tsx. Anyone who has been in a Meet call
/// already knows how it works, which is the entire point -- there is nothing to
/// learn.
/// </summary>
public sealed class PillControl : UserControl
{
    private readonly Button _chevron;
    private readonly ToggleButton _toggle;
    private readonly FontIcon _icon;
    private readonly Border _pill;
    private readonly MenuFlyout _menu = new();

    private readonly string _onGlyph;
    private readonly string _offGlyph;
    private readonly string _label;

    private bool _enabled = true;

    /// <summary>"off" reads as a warning state, matching Meet's muted red.
    /// A literal colour rather than a theme brush: on the dark toolbar the
    /// token resolved to something barely distinguishable from "on".</summary>
    private static readonly Color OffColor = Color.FromArgb(255, 196, 43, 28);

    public event Action<bool>? Toggled;
    public event Action<string>? DeviceSelected;

    /// <summary>Raised just before the device menu opens, so the list can be
    /// refreshed for anything plugged in since launch.</summary>
    public event Action? DevicesRequested;

    public PillControl(string label, string onGlyph, string offGlyph)
    {
        _label = label;
        _onGlyph = onGlyph;
        _offGlyph = offGlyph;

        // Re-enumerate just before the menu opens, so a device plugged in since
        // launch appears. Cheaper and more predictable than polling, since
        // enumeration shells out to ffmpeg.
        _menu.Opening += (_, _) => DevicesRequested?.Invoke();

        _chevron = new Button
        {
            Content = new FontIcon { Glyph = Glyphs.ChevronUp, FontSize = 16 },
            Width = 30,
            Padding = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0),
            VerticalAlignment = VerticalAlignment.Stretch,
            Flyout = _menu,
        };
        ToolTipService.SetToolTip(_chevron, $"Choose {label.ToLowerInvariant()}");

        _icon = new FontIcon { Glyph = onGlyph, FontSize = 18 };
        _toggle = new ToggleButton
        {
            Content = _icon,
            Width = 46,
            Padding = new Thickness(0),
            Background = new SolidColorBrush(Colors.Transparent),
            BorderThickness = new Thickness(0),
            CornerRadius = new CornerRadius(0),
            IsChecked = true,
            VerticalAlignment = VerticalAlignment.Stretch,
        };
        _toggle.Click += (_, _) => SetEnabled(_toggle.IsChecked == true, notify: true);

        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(_chevron);
        row.Children.Add(_toggle);

        _pill = new Border
        {
            Child = row,
            Height = 40,
            CornerRadius = new CornerRadius(20),
            Background = new SolidColorBrush(Color.FromArgb(255, 45, 45, 45)),
        };

        Content = _pill;
        UpdateVisual();
    }

    public void SetEnabled(bool enabled, bool notify = false)
    {
        _enabled = enabled;
        _toggle.IsChecked = enabled;
        UpdateVisual();
        if (notify) Toggled?.Invoke(enabled);
    }

    private void UpdateVisual()
    {
        _icon.Glyph = _enabled ? _onGlyph : _offGlyph;
        _pill.Background = new SolidColorBrush(_enabled
            ? Color.FromArgb(255, 45, 45, 45)
            : OffColor);
        ToolTipService.SetToolTip(_toggle, $"{_label}: {(_enabled ? "on" : "off")}");
    }

    /// <summary>Populate the chevron menu. The current device is check-marked.</summary>
    public void SetDevices(IReadOnlyList<string> devices, string? selected)
    {
        _menu.Items.Clear();

        if (devices.Count == 0)
        {
            _menu.Items.Add(new MenuFlyoutItem { Text = "No devices found", IsEnabled = false });
            return;
        }

        foreach (var device in devices)
        {
            var item = new ToggleMenuFlyoutItem
            {
                Text = device,
                IsChecked = string.Equals(device, selected, StringComparison.Ordinal),
            };
            item.Click += (_, _) =>
            {
                // Radio behaviour: exactly one device is current.
                foreach (var other in _menu.Items.OfType<ToggleMenuFlyoutItem>())
                    other.IsChecked = ReferenceEquals(other, item);
                DeviceSelected?.Invoke(device);
            };
            _menu.Items.Add(item);
        }
    }
}
